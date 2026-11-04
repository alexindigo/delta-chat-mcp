// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ModernRelay, payload } from "../opencode/modern-relay.ts";
import { RelayFailure } from "../opencode/relay.ts";
import { object } from "../opencode/types.ts";
import {
  type Delivery,
  fingerprint,
  type Outcome,
  scopeOf,
  Store,
} from "./store.ts";
import { incoming } from "./prompt.ts";

const names = new Set([
  "status",
  "list_contacts",
  "list_chats",
  "read_messages",
  "send_message",
  "message_status",
  "delete_messages",
  "create_room",
  "room_subscribe",
  "room_subscriptions",
  "room_leave",
  "room_resume",
]);
export const publicName = (name: string) => names.has(name);
export interface Host {
  ready(session: string, signal: AbortSignal): Promise<boolean>;
  inputID(): string;
  admit(delivery: Delivery, text: string, signal: AbortSignal): Promise<void>;
  tool(alias: string, name: string): string;
  turn(session: string, call: string): string | undefined;
  notice(message: string): void;
}
export type Relay = Pick<
  ModernRelay,
  | "config"
  | "scope"
  | "catalog"
  | "rawCall"
  | "inbox"
  | "claim"
  | "bodies"
  | "call"
  | "startReceiver"
  | "close"
>;
export interface Definition {
  alias: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One owner of remote delivery and explicit-send policy for both native hosts. */
export class Coordinator {
  readonly lifetime = new AbortController();
  #job?: Promise<void>;
  #dirty = false;
  #retry?: ReturnType<typeof setTimeout>;
  #retryNeeded = false;
  #closing?: Promise<void>;
  #calls = new Set<Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly relays: ReadonlyMap<string, Relay>,
    readonly host: Host,
  ) {}
  async catalog(): Promise<Definition[]> {
    const result: Definition[] = [];
    for (const [alias, relay] of this.relays) {
      if (!relay.config.enabled) continue;
      for (const tool of await relay.catalog(this.lifetime.signal)) {
        if (!publicName(tool.name)) continue;
        const schema = structuredClone(tool.inputSchema) as Record<
          string,
          unknown
        >;
        const properties = object(schema.properties);
        delete properties.session_id;
        schema.properties = properties;
        if (Array.isArray(schema.required)) {
          schema.required = schema.required.filter((k) => k !== "session_id");
        }
        result.push({
          alias,
          name: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: schema,
        });
      }
    }
    return result;
  }
  start() {
    this.store.assertOwner();
    for (const relay of this.relays.values()) {
      if (relay.config.enabled) {
        relay.startReceiver(
          () => this.reconcile(),
          this.lifetime.signal,
          (text) => Promise.resolve(this.host.notice(text)),
        );
      }
    }
  }
  kick() {
    if (this.lifetime.signal.aborted) return;
    this.#dirty = true;
    if (this.#job) return;
    this.#job = Promise.resolve().then(async () => {
      try {
        while (this.#dirty && !this.lifetime.signal.aborted) {
          this.#dirty = false;
          this.#retryNeeded = false;
          await this.#drain();
        }
      } catch {
        this.#retryNeeded = true;
        if (!this.lifetime.signal.aborted) {
          this.host.notice(
            "delta-chat-mcp: reconciliation pending; no uncertain input or send will be replayed.",
          );
        }
      } finally {
        this.#job = undefined;
        if (!this.lifetime.signal.aborted && this.#retryNeeded) {
          clearTimeout(this.#retry);
          this.#retry = setTimeout(() => this.kick(), 1000);
        }
      }
    });
  }
  async reconcile() {
    this.kick();
    await this.#job;
  }
  input(session: string, input: string, id?: string, turn = input) {
    if (this.lifetime.signal.aborted) return;
    const old = this.store.pending(session);
    if (id && old?.id === id && old.input === input) {
      this.store.observe(id, session, input, turn);
    } else if (old?.state === "observed" && old.turn !== turn) {
      this.store.settle(old.id, "superseded_by_native_input");
    }
    this.kick();
  }
  finished(
    session: string,
    turn: string,
    reason: "finished" | Outcome = "finished",
  ) {
    if (this.lifetime.signal.aborted) return;
    this.store.finish(session, turn, reason);
    this.kick();
  }
  async #drain() {
    const signal = this.lifetime.signal;
    this.store.assertOwner();
    for (const [alias, relay] of this.relays) {
      if (!relay.config.enabled) continue;
      signal.throwIfAborted();
      const scope = await relay.scope(signal);
      for (const row of this.store.deliveries()) {
        if (
          row.state !== "settled" || !row.token || !row.outcome ||
          row.identity !== scope.identity || row.uri !== scope.uri
        ) continue;
        await relay.call(
          "inbox_complete",
          { delivery_id: row.id, claim_token: row.token, outcome: row.outcome },
          signal,
          undefined,
          scopeOf(row),
        );
        this.store.completed(row.id);
      }
      const inbox = await relay.inbox(signal, scope);
      for (const remote of inbox.deliveries) {
        signal.throwIfAborted();
        if (
          remote.state === "completed" ||
          !this.store.bound(remote.target_session, scope)
        ) continue;
        let row = this.store.delivery(remote.delivery_id);
        if (row && !["intent", "claimed"].includes(row.state)) continue;
        const pending = this.store.pending(remote.target_session);
        if (pending && pending.id !== remote.delivery_id) continue;
        if (!await this.host.ready(remote.target_session, signal)) {
          this.#retryNeeded = true;
          continue;
        }
        row ??= this.store.intent(remote.delivery_id);
        let claim;
        try {
          claim = await relay.claim(
            remote.delivery_id,
            row.claimant,
            signal,
            remote.target_session,
            scope,
          );
        } catch (error) {
          // A frozen claim/recipient conflict defers only this delivery.
          if (error instanceof RelayFailure && error.kind === "tool_error") {
            continue;
          }
          throw error;
        }
        if (claim.state === "completed") continue;
        row = this.store.claim(alias, scope, claim);
        const bodies = await relay.bodies(
          row.id,
          row.token!,
          signal,
          scopeOf(row),
        );
        const ids = JSON.parse(row.ids) as number[];
        if (
          ids.length !== bodies.messages.length ||
          ids.some((id, index) => bodies.messages[index].id !== id)
        ) {
          this.store.settle(row.id, "source_deleted");
          this.#dirty = true;
          continue;
        }
        // A concurrent native prompt/leave/disable during the body read is a fence.
        signal.throwIfAborted();
        if (
          !relay.config.enabled || !await this.host.ready(row.session!, signal)
        ) {
          this.#retryNeeded = true;
          continue;
        }
        row = this.store.prepare(row.id, this.host.inputID());
        try {
          await this.host.admit(
            row,
            incoming(row, bodies.messages, {
              send: this.host.tool(alias, "send_message"),
              read: this.host.tool(alias, "read_messages"),
              leave: this.host.tool(alias, "room_leave"),
            }),
            signal,
          );
        } catch {
          this.host.notice(
            `delta-chat-mcp: native delivery ${row.id} is uncertain; retained without replay.`,
          );
        }
      }
    }
  }
  call(
    alias: string,
    name: string,
    args: unknown,
    session: string,
    callID: string,
    signal?: AbortSignal,
  ) {
    const task = this.#call(alias, name, args, session, callID, signal);
    this.#calls.add(task);
    void task.finally(() => this.#calls.delete(task)).catch(() => {});
    return task;
  }
  async #call(
    alias: string,
    name: string,
    args: unknown,
    session: string,
    callID: string,
    external?: AbortSignal,
  ): Promise<CallToolResult> {
    if (!publicName(name) || !session || !callID) {
      throw new Error("Native public tool context required");
    }
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(external ? [external] : []),
    ]);
    signal.throwIfAborted();
    this.store.assertOwner();
    const relay = this.relays.get(alias);
    if (!relay?.config.enabled) throw new Error("Relay is paused");
    const scope = await relay.scope(signal);
    this.store.bind(session, alias, scope);
    const clean = Object.fromEntries(
      Object.entries(object(args)).filter(([key]) =>
        !["session_id", "_meta"].includes(key)
      ),
    );
    const sendID = fingerprint([scope, session, callID, alias, name]);
    if (name === "send_message") {
      const hash = fingerprint(clean);
      const previous = this.store.send(sendID);
      if (previous) {
        if (previous.fingerprint !== hash) {
          throw new Error(
            "Native send reference reused with different arguments",
          );
        }
        if (previous.state === "sent") {
          const data = {
            message_id: previous.core_id,
            chat_id: previous.chat,
            state: previous.core_state,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          };
        }
        throw new Error(
          "Previous send is unconfirmed; inspect chat history before a deliberate new send",
        );
      }
      const pending = this.store.pending(session);
      const delivery = pending?.state === "observed" &&
          pending.turn === this.host.turn(session, callID) &&
          pending.chat === clean.chat_id && pending.identity === scope.identity
        ? pending.id
        : null;
      this.store.prepareSend(sendID, hash, delivery);
    }
    let result;
    try {
      signal.throwIfAborted();
      result = await relay.rawCall(name, clean, signal, session, scope);
    } catch (error) {
      if (name === "send_message") {
        this.store.finishSend(
          sendID,
          error instanceof RelayFailure && error.retrySafe
            ? "rejected"
            : "uncertain",
        );
      }
      throw new Error(
        "Relay call unconfirmed; inspect chat history before retrying a send",
        { cause: error },
      );
    }
    if (name === "send_message") {
      try {
        const core = z.object({
          message_id: z.number().int().positive(),
          chat_id: z.number().int().positive(),
          state: z.string(),
        }).parse(payload(result));
        this.store.finishSend(sendID, "sent", core);
      } catch {
        // Keep the actual returned envelope; a local receipt failure cannot turn
        // an accepted send into a model-visible "not sent" result.
        try {
          this.store.finishSend(sendID, "uncertain");
        } catch { /* Durable attempting intent remains conservative. */ }
        this.host.notice(
          "delta-chat-mcp: send receipt unconfirmed; inspect chat history before resending.",
        );
      }
    }
    this.kick();
    return result;
  }
  close(releaseOwnership = true) {
    this.lifetime.abort();
    clearTimeout(this.#retry);
    return this.#closing ??= (async () => {
      const stopped = await Promise.allSettled(
        [...this.relays.values()].map((relay) => relay.close()),
      );
      await this.#job;
      await Promise.allSettled([...this.#calls]);
      if (stopped.some((s) => s.status === "rejected")) {
        throw new Error("Channel transport cleanup failed; ownership retained");
      }
      if (releaseOwnership) this.store.release();
    })();
  }
}
