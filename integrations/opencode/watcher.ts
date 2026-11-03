// SPDX-License-Identifier: LGPL-3.0-only
import { setTimeout as delay } from "node:timers/promises";
import type { Registry } from "./registry.ts";
import { type Relay, RelayFailure } from "./relay.ts";
import type { RelayMessage, Subscription } from "./types.ts";

export const humanMessage = (message: RelayMessage) =>
  !message.fromSelf && message.fromContactId > 9 && !message.isInfo &&
  !message.isBot;
const key = (s: Subscription) =>
  JSON.stringify([s.session_id, s.relay, s.chat_id]);
export interface WatcherPorts {
  registry(): Registry;
  relays: ReadonlyMap<string, Relay>;
  owner: string;
  directory: string;
  holder: string;
  waitSeconds: number;
  signal: AbortSignal;
  changed(session: string): void;
  blocked(row: Subscription): Promise<void>;
}

/** Owns repeatable reads/waits, never prompts. One cursor/ring per subscription. */
export class Watcher {
  #watches = new Map<
    string,
    {
      alias: string;
      relay: Relay;
      anchor: number;
      abort: AbortController;
      task: Promise<void>;
    }
  >();
  #tasks = new Set<Promise<void>>();
  #sync?: Promise<void>;
  #timer?: ReturnType<typeof setTimeout>;
  #closed = false;
  #dirty = false;
  constructor(private readonly ports: WatcherPorts) {}
  kick() {
    if (this.#closed || this.ports.signal.aborted) return;
    this.#dirty = true;
    if (this.#sync) return;
    this.#sync = Promise.resolve().then(async () => {
      try {
        while (this.#dirty && !this.ports.signal.aborted) {
          this.#dirty = false;
          await this.#synchronize();
        }
      } catch {
        /* A failed read/health hint is retried on the bounded tick. */
      } finally {
        // Preserve immediate hints as well as the existing legacy retry tick.
        this.#sync = undefined;
        if (!this.#closed && !this.ports.signal.aborted) {
          this.#timer = setTimeout(() => this.kick(), 10_000);
        }
      }
    });
    clearTimeout(this.#timer);
  }
  async #synchronize() {
    const registry = this.ports.registry();
    const wanted = new Set<string>();
    const subscriptions = registry.subscriptions().filter((s) =>
      s.owner_server === this.ports.owner &&
      s.directory === this.ports.directory
    );
    const enabledEdges = new Map<Relay, boolean>();
    // Disable belongs to each configured transport edge, including a previously
    // used alias whose pool remains after a subscription switched aliases.
    for (
      const relay of subscriptions.length ? this.ports.relays.values() : []
    ) {
      try {
        enabledEdges.set(relay, await relay.refreshNativeState());
      } catch { /* One unavailable edge cannot poison the other aliases. */ }
      if (this.#closed || this.ports.signal.aborted) return;
    }
    for (const original of subscriptions) {
      if (
        original.owner_server !== this.ports.owner ||
        original.directory !== this.ports.directory ||
        ["left", "orphaned", "blocked_discontinuity"].includes(original.state)
      ) continue;
      let row = original;
      const relay = this.ports.relays.get(row.alias);
      if (!relay || !enabledEdges.has(relay)) continue;
      const enabled = enabledEdges.get(relay)!;
      this.ports.signal.throwIfAborted();
      row = registry.subscriptions(row.session_id).find((r) =>
        key(r) === key(row)
      )!;
      if (["left", "orphaned", "blocked_discontinuity"].includes(row.state)) {
        continue;
      }
      if (!enabled) {
        if (row.state !== "paused") {
          registry.write((tx) =>
            tx.putSubscription({
              ...row,
              state: "paused",
              updated_at: Date.now(),
            })
          );
        }
        continue;
      }
      if (row.state === "paused" || row.state === "unroutable") {
        row = { ...row, state: "active", updated_at: Date.now() };
        registry.write((tx) => tx.putSubscription(row));
        this.ports.changed(row.session_id);
      }
      if (
        !registry.write((tx) =>
          tx.acquireLease(
            row.session_id,
            this.ports.holder,
            this.ports.owner,
            Date.now(),
          )
        )
      ) continue;
      const id = key(row);
      wanted.add(id);
      const prior = this.#watches.get(id);
      if (
        prior &&
        (prior.alias !== row.alias || prior.relay !== relay ||
          prior.anchor !== row.anchor_id)
      ) {
        prior.abort.abort();
        await prior.task;
        if (this.#closed || this.ports.signal.aborted) return;
      }
      if (!this.#watches.has(id)) {
        const abort = new AbortController();
        const signal = AbortSignal.any([abort.signal, this.ports.signal]);
        const task = Promise.resolve().then(() =>
          this.#watch(row, relay, signal)
        ).finally(() => {
          if (this.#watches.get(id)?.task === task) this.#watches.delete(id);
          this.#tasks.delete(task);
        });
        this.#watches.set(id, {
          alias: row.alias,
          relay,
          anchor: row.anchor_id,
          abort,
          task,
        });
        this.#tasks.add(task);
        this.ports.changed(row.session_id);
      }
    }
    for (const [id, watch] of this.#watches) {
      if (!wanted.has(id)) watch.abort.abort();
    }
  }
  async #watch(initial: Subscription, relay: Relay, signal: AbortSignal) {
    let failures = 0;
    let recovery: { stored: number; after: number } | undefined;
    while (!signal.aborted) {
      try {
        const row = this.ports.registry().subscriptions(initial.session_id)
          .find((s) => key(s) === key(initial));
        if (
          !row || row.state !== "active" || row.alias !== initial.alias ||
          row.owner_server !== this.ports.owner ||
          row.directory !== this.ports.directory
        ) return;
        if (
          !this.ports.registry().write((tx) =>
            tx.acquireLease(
              row.session_id,
              this.ports.holder,
              this.ports.owner,
              Date.now(),
            )
          )
        ) return;
        const owned = this.#watches.get(key(row));
        if (owned) owned.anchor = row.anchor_id;
        // A stored identity never authorizes a different alias edge's history.
        if (await relay.identity(signal) !== row.relay) return;
        let page;
        try {
          page = (await relay.wait(
            row.chat_id,
            recovery?.stored === row.anchor_id ? recovery.after : row.anchor_id,
            this.ports.waitSeconds,
            signal,
          )).messages;
        } catch (error) {
          if (
            !(error instanceof RelayFailure) || error.reason !== "not_found"
          ) throw error;
          page = undefined;
          for (const anchor of [...row.recent_ids].reverse()) {
            if (anchor === row.anchor_id) continue;
            try {
              page = (await relay.read(row.chat_id, anchor, signal)).messages;
              recovery = { stored: row.anchor_id, after: anchor };
              break;
            } catch (error) {
              if (
                !(error instanceof RelayFailure) || error.reason !== "not_found"
              ) throw error;
            }
          }
          if (page === undefined) {
            signal.throwIfAborted();
            const blocked = this.ports.registry().write((tx) => {
              const current = tx.subscription(row);
              if (
                !current || current.state !== "active" ||
                current.anchor_id !== row.anchor_id ||
                current.alias !== row.alias ||
                current.owner_server !== this.ports.owner ||
                current.directory !== this.ports.directory
              ) return undefined;
              const blocked: Subscription = {
                ...current,
                state: "blocked_discontinuity",
                updated_at: Date.now(),
              };
              tx.putSubscription(blocked);
              return blocked;
            });
            if (blocked) await this.ports.blocked(blocked);
            return;
          }
        }
        signal.throwIfAborted();
        if (page.length) {
          const committed = this.ports.registry().write((tx) =>
            tx.recordBatch(
              row,
              row.anchor_id,
              page.map((m) => m.id),
              page.filter(humanMessage).map((m) => m.id),
              Date.now(),
            )
          );
          if (committed) {
            if (owned) owned.anchor = page.at(-1)!.id;
            this.ports.changed(row.session_id);
          }
        } else await delay(50, undefined, { signal });
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (
          error instanceof RelayFailure &&
          ["paused", "auth_failed"].includes(error.kind)
        ) return;
        // retrySafe is send-only safety. Non-send uncertain reads are repeatable.
        try {
          await delay(
            Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)),
            undefined,
            { signal },
          );
        } catch {
          return;
        }
      }
    }
  }
  async close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const watch of this.#watches.values()) watch.abort.abort();
    await this.#sync;
    for (const watch of this.#watches.values()) watch.abort.abort();
    await Promise.allSettled([...this.#tasks]);
  }
}
