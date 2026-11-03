// SPDX-License-Identifier: LGPL-3.0-only
import { type Registry, RemoteClaimConflict } from "./registry.ts";
import type { OpenCode } from "./opencode.ts";
import { ModernRelay } from "./modern-relay.ts";
import {
  type Delivery,
  isTerminalDelivery,
  positiveID,
  sameRelayScope,
} from "./types.ts";
import { RelayFailure } from "./relay.ts";

export interface InboxPorts {
  registry(): Registry;
  opencode: Pick<OpenCode, "session" | "status">;
  relays: ReadonlyMap<string, ModernRelay>;
  owner: string;
  directory: string;
  signal: AbortSignal;
  changed(session: string): void;
  notify(message: string): Promise<void>;
  now?(): number;
}
/** Bridges server-owned claims into the existing v1 admission/completion ledger.
 * Unclaimed busy work remains on the server and can keep batching/reassigning. */
export class Inbox {
  #jobs = new Map<string, Promise<void>>();
  #dirty = new Set<string>();
  #closed = false;
  #blockedNotices = new Set<string>();
  #scopeNotices = new Set<string>();
  constructor(private readonly ports: InboxPorts) {}
  start() {
    for (const [alias, relay] of this.ports.relays) {
      if (relay.config.enabled) {
        relay.startReceiver(
          () => this.sync(alias),
          this.ports.signal,
          this.ports.notify,
        );
      }
    }
  }
  all() {
    for (const alias of this.ports.relays.keys()) {
      void this.sync(alias).catch(() => {});
    }
  }
  sync(alias: string): Promise<void> {
    if (this.#closed || this.ports.signal.aborted) return Promise.resolve();
    this.#dirty.add(alias);
    const prior = this.#jobs.get(alias);
    if (prior) return prior;
    const job = Promise.resolve().then(async () => {
      try {
        while (this.#dirty.delete(alias) && !this.ports.signal.aborted) {
          await this.#read(alias);
        }
      } finally {
        // No promise-settlement gap between the last dirty check and release.
        this.#jobs.delete(alias);
      }
    });
    this.#jobs.set(alias, job);
    return job;
  }
  async #read(alias: string) {
    const relay = this.ports.relays.get(alias);
    if (!relay || !await relay.refreshNativeState()) return;
    const registry = this.ports.registry();
    const scope = await relay.scope(this.ports.signal);
    let deferred: RelayFailure | undefined;
    // Complete terminal native outcomes even after restart/lost completion ack.
    for (const d of registry.deliveries()) {
      const s = registry.subscriptions(d.session_id).find((s) =>
        s.relay === d.relay && s.chat_id === d.chat_id
      );
      const claim = registry.remoteClaim(d.id);
      const edge = registry.deliveryEdge(d.id);
      if (
        !s || s.owner_server !== this.ports.owner ||
        s.directory !== this.ports.directory || !claim?.token ||
        claim.completed ||
        !isTerminalDelivery(d.state) || !edge || !sameRelayScope(edge, scope)
      ) continue;
      try {
        await relay.call(
          "inbox_complete",
          {
            delivery_id: d.id,
            claim_token: claim.token,
            outcome: d.state,
          },
          this.ports.signal,
          undefined,
          edge,
        );
        registry.completeRemote(d.id, this.ports.now?.() ?? Date.now());
      } catch (error) {
        if (
          !(error instanceof RelayFailure) || error.domain !== "application"
        ) throw error;
        deferred ??= error;
      }
    }
    const inbox = await relay.inbox(this.ports.signal, scope);
    for (const room of inbox.rooms) {
      const key = JSON.stringify([alias, room.chat_id, room.anchor_id]);
      if (
        room.state === "blocked_discontinuity" && !this.#blockedNotices.has(key)
      ) {
        this.#blockedNotices.add(key);
        await this.ports.notify(
          `delta-chat-mcp: room ${room.chat_id} blocked_discontinuity at ${room.anchor_id}; inspect room_subscriptions and explicitly room_resume.`,
        );
      }
    }
    const identity = scope.identity;
    const bindings = registry.remoteBindings().filter((b) =>
      b.owner === this.ports.owner && b.directory === this.ports.directory &&
      b.relay === scope.identity && b.uri === scope.uri
    );
    for (const d of inbox.deliveries) {
      if (d.state === "completed") continue;
      if (
        d.state === "ready" &&
        inbox.rooms.some((r) =>
          r.chat_id === d.chat_id && r.state === "blocked_discontinuity"
        )
      ) continue;
      const binding = bindings.find((b) => b.session === d.target_session);
      if (!binding || binding.relay !== identity) continue;
      const known = registry.deliveries().find((local) =>
        local.id === d.delivery_id
      );
      if (known) {
        const edge = registry.deliveryEdge(known.id);
        if (edge && sameRelayScope(edge, scope)) {
          this.ports.changed(known.session_id);
        }
        continue;
      }
      const progress = registry.remoteClaim(d.delivery_id);
      if (d.claimant && d.claimant !== progress?.claimant) continue;
      if (!progress?.token) {
        // Native busy/revert and older in-flight work defer CLAIM, not just POST.
        // Thus repeated messages remain one mutable server batch while busy.
        const info = await this.ports.opencode.session(binding.session);
        const statuses = await this.ports.opencode.status();
        if (
          !info || info.revert ||
          (statuses[binding.session] &&
            statuses[binding.session].type !== "idle") ||
          registry.deliveries(binding.session).some((local) =>
            !isTerminalDelivery(local.state) &&
            !registry.execution(local.id, local.continuations)?.answerID &&
            // Only a native submission reserves the session. An open batch in
            // another room may be waiting on its own edge/body preparation.
            (registry.submissions(local.id).length > 0 ||
              local.chat_id === d.chat_id && local.relay === binding.relay)
          )
        ) continue;
      }
      this.ports.signal.throwIfAborted();
      const edge = { ...scope, alias };
      let claimant: string;
      let claim;
      try {
        claimant = registry.prepareRemoteClaim(d.delivery_id, edge);
        claim = await relay.claim(
          d.delivery_id,
          claimant,
          this.ports.signal,
          binding.session,
          scope,
        );
      } catch (error) {
        // Expected server races and a frozen different local scope defer only
        // this delivery. Uncertain transport outcomes still reach the owner.
        if (error instanceof RelayFailure && error.domain === "application") {
          continue;
        }
        if (error instanceof RemoteClaimConflict) continue;
        throw error;
      }
      if (
        claim.delivery_id !== d.delivery_id ||
        claim.target_session !== binding.session || claim.chat_id !== d.chat_id
      ) continue;
      this.ports.signal.throwIfAborted();
      try {
        registry.importRemote({
          id: claim.delivery_id,
          session: binding.session,
          alias,
          relay: binding.relay,
          chat: claim.chat_id,
          anchor: claim.from_anchor,
          ids: claim.message_ids,
          token: claim.claim_token,
          claimant,
          owner: this.ports.owner,
          directory: this.ports.directory,
          edge,
        });
      } catch (error) {
        if (error instanceof RemoteClaimConflict) continue;
        throw error;
      }
      this.ports.changed(binding.session);
    }
    registry.write((tx) => tx.prune(this.ports.now?.() ?? Date.now()));
    // Retry this receipt under the receiver's backoff, after servicing the rest
    // of the canonical batch. One application's outcome cannot starve a room.
    if (deferred) throw deferred;
  }
  #binding(d: Delivery) {
    const registry = this.ports.registry();
    const s = registry.subscriptions(d.session_id).find((s) =>
      s.relay === d.relay && s.chat_id === d.chat_id
    );
    const claim = registry.remoteClaim(d.id);
    if (
      !s || s.owner_server !== this.ports.owner ||
      s.directory !== this.ports.directory || !claim?.token
    ) return;
    const edge = registry.deliveryEdge(d.id);
    if (!edge || edge.identity !== d.relay) return;
    return { edge, token: claim.token };
  }
  /** Cached eligibility is only a scheduling hint. Each operation revalidates. */
  ready(d: Delivery): boolean {
    if (this.#closed || this.ports.signal.aborted) return false;
    const binding = this.#binding(d);
    return !!binding &&
      [...this.ports.relays.values()].some((r) => r.matchesScope(binding.edge));
  }
  async transport(d: Delivery) {
    if (this.#closed || this.ports.signal.aborted) return;
    const binding = this.#binding(d);
    if (!binding) {
      if (!this.#scopeNotices.has(d.id)) {
        this.#scopeNotices.add(d.id);
        await this.ports.notify(
          `delta-chat-mcp: delivery ${d.id} authorization scope unavailable; inspect subscriptions.`,
        );
      }
      return;
    }
    const { edge: scope } = binding;
    const candidates = [...this.ports.relays].sort(([a], [b]) =>
      Number(b === scope.alias) - Number(a === scope.alias)
    );
    for (const [alias, relay] of candidates) {
      if (!relay.config.enabled || !await relay.refreshNativeState()) continue;
      try {
        if (!sameRelayScope(await relay.scope(this.ports.signal), scope)) {
          continue;
        }
      } catch {
        this.ports.signal.throwIfAborted();
        continue;
      }
      const current = () =>
        !this.#closed && !this.ports.signal.aborted &&
        relay.matchesScope(scope);
      // The adapter captures the immutable claim scope, not a subscription alias.
      // The same existing client validates that scope at actual dispatch time.
      const scoped = {
        get health() {
          return relay.health;
        },
        refreshNativeState: () => Promise.resolve(current()),
        identity: async (signal?: AbortSignal) =>
          (await relay.scope(signal, scope)).identity,
        call: (
          name: string,
          args: Record<string, unknown>,
          signal?: AbortSignal,
        ) => relay.call(name, args, signal, undefined, scope),
        read: (
          chat: number,
          after?: number,
          signal?: AbortSignal,
          before?: number,
        ) => relay.read(chat, after, signal, before, scope),
        send: (chat: number, text: string, signal?: AbortSignal) =>
          relay.send(chat, text, signal, scope),
      };
      return { alias, relay: scoped, token: binding.token, scope, current };
    }
  }
  async #edge(d: Delivery) {
    const edge = await this.transport(d);
    if (!edge) throw new RelayFailure("paused", false, undefined, "guard");
    return edge;
  }
  async bodies(d: Delivery) {
    const edge = await this.#edge(d);
    const relay = this.ports.relays.get(edge.alias)!;
    const { messages } = await relay.bodies(
      d.id,
      edge.token,
      this.ports.signal,
      edge.scope,
    );
    if (
      messages.length !== d.message_ids.length ||
      messages.some((m, i) =>
        m.id !== d.message_ids[i] || m.chatId !== d.chat_id
      )
    ) return undefined;
    return messages;
  }
  async mirror(d: Delivery, text: string) {
    const { relay, token } = await this.#edge(d);
    const result = await relay.call("inbox_mirror", {
      delivery_id: d.id,
      claim_token: token,
      text,
    }, this.ports.signal);
    if (result.mirror !== "sent" || result.chat_id !== d.chat_id) {
      throw new RelayFailure("uncertain", false);
    }
    return {
      chat_id: d.chat_id,
      message_id: positiveID.parse(result.message_id),
    };
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#jobs.values()]);
  }
}
