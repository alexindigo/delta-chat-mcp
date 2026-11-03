// SPDX-License-Identifier: LGPL-3.0-only
import type { ChangeHub } from "../events.ts";
import { UnknownMessageAnchor } from "./chats.ts";
import type { ChatsService } from "./chats.ts";
import type { SendService } from "./send.ts";
import type { Message } from "./message.ts";
import {
  type RoomMember,
  RoomRoutingStore,
  type RoutedRoom,
  type RoutingMetadata,
} from "./room-routing-store.ts";

export const inboxUri = (namespace: string) => `deltachat://inbox/${namespace}`;
const memberID = (m: RoomMember) => JSON.stringify([m.namespace, m.session_id]);
export const isRoomHuman = (m: Message) =>
  !m.fromSelf && m.fromContactId > 9 && !m.isInfo && !m.isBot;
export interface RoutingPorts {
  chats: Pick<
    ChatsService,
    "get" | "messages" | "routingMessages" | "markSeen"
  >;
  send: Pick<SendService, "sendText">;
  events: ChangeHub;
  authorized(owner: string): boolean;
  now?(): number;
}

/** Relay-owned subscriptions, canonical-order scan and delivery control. Hints
 * only dirty the scanner; persisted IDs/claims, never notifications, are truth. */
export class RoomRouting {
  #listeners = new Set<(uri: string) => void>();
  #off: () => void;
  #job?: Promise<void>;
  #dirty = false;
  #closed = false;
  #retry?: ReturnType<typeof setTimeout>;
  #controls = new Set<Promise<unknown>>();
  #now() {
    return this.ports.now?.() ?? Date.now();
  }
  #prune(s: RoutingMetadata) {
    const cutoff = this.#now() - 7 * 86400_000;
    s.deliveries = s.deliveries.filter((d) =>
      d.state !== "completed" || d.completed_at === undefined ||
      d.completed_at >= cutoff ||
      d.mirror === "attempting" || d.mirror === "uncertain" ||
      d.outcome?.includes("uncertain")
    );
    const latest = new Map(s.notices.map((n) => [n.chat_id, n]));
    s.notices = s.notices.filter((n) =>
      latest.get(n.chat_id) === n || n.state !== "sent" ||
      n.completed_at === undefined || n.completed_at >= cutoff
    );
    s.namespaces = s.namespaces.filter((n) =>
      this.ports.authorized(n.owner) ||
      s.rooms.some((r) => r.members.some((m) => m.namespace === n.id)) ||
      s.deliveries.some((d) => d.namespace === n.id) ||
      s.notices.some((notice) =>
        notice.recipient && JSON.parse(notice.recipient)[0] === n.id
      )
    );
  }
  constructor(
    readonly store: RoomRoutingStore,
    private readonly ports: RoutingPorts,
  ) {
    this.#off = ports.events.subscribe((event) => {
      if (
        ["messages", "connectivity", "chats", "account"].includes(event.type)
      ) {
        this.kick();
      }
    });
    // An interrupted core call has an unknown outcome, never replay rights.
    store.write((s) => {
      for (const d of s.deliveries) {
        if (d.mirror === "attempting") d.mirror = "uncertain";
      }
      for (const n of s.notices) {
        if (n.state === "attempting") n.state = "uncertain";
      }
    });
    this.kick();
  }
  namespace(owner: string): string {
    this.#auth(owner);
    return this.store.write((s) => {
      this.#prune(s);
      let row = s.namespaces.find((n) => n.owner === owner);
      if (!row) s.namespaces.push(row = { owner, id: crypto.randomUUID() });
      return row.id;
    });
  }
  #auth(owner: string) {
    if (this.#closed || !this.ports.authorized(owner)) {
      throw new Error("Inbox access denied");
    }
  }
  subscribeUpdates(listener: (uri: string) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #changed(s: RoutingMetadata) {
    for (const n of s.namespaces) {
      for (const listener of this.#listeners) listener(inboxUri(n.id));
    }
  }
  #recipient(s: RoutingMetadata, room: RoutedRoom) {
    const valid = room.members.filter((m) =>
      m.joined &&
      s.namespaces.some((n) =>
        n.id === m.namespace && this.ports.authorized(n.owner)
      )
    ).sort((a, b) => b.interest - a.interest)[0];
    const next = valid ? memberID(valid) : null;
    if (next === room.recipient) return;
    room.recipient = next;
    for (const d of s.deliveries) {
      if (
        d.chat_id === room.chat_id && d.interval === room.interval &&
        d.state === "ready" && valid
      ) {
        d.namespace = valid.namespace;
        d.target_session = valid.session_id;
      }
    }
    s.notices.push({
      chat_id: room.chat_id,
      recipient: next,
      state: "attempting",
    });
  }
  async #room(chat: number) {
    const room = await this.ports.chats.get(chat);
    if (room.type !== "Group" || !room.selfInGroup) {
      throw new Error("Joined room required");
    }
  }
  async subscribe(
    owner: string,
    session: string,
    chat: number,
    acceptedMessageID?: number,
  ) {
    this.#auth(owner);
    await this.#room(chat);
    while (true) {
      const observed = this.store.read().rooms.find((r) => r.chat_id === chat);
      const interval = observed?.interval ?? 0;
      const active = observed?.members.some((m) => m.joined) ?? false;
      // A send's accepted ID is the boundary even if a peer has already replied.
      // Explicit subscribe samples a boundary only when opening a fresh interval.
      const boundary = acceptedMessageID ??
        (active
          ? undefined
          : (await this.ports.chats.messages(chat, { limit: 1 })).at(-1)?.id);
      this.#auth(owner);
      const ns = this.namespace(owner);
      const result = this.store.write((s) => {
        let room = s.rooms.find((r) => r.chat_id === chat);
        // A leave/rejoin during the asynchronous snapshot requires a fresh read.
        if ((room?.interval ?? 0) !== interval) return undefined;
        if (!room) {
          room = {
            chat_id: chat,
            interval: 0,
            anchor_id: null,
            recent_ids: [],
            state: "active",
            members: [],
            recipient: null,
          };
          s.rooms.push(room);
        }
        if (!room.members.some((m) => m.joined)) {
          room.interval++;
          room.anchor_id = boundary ?? null;
          room.recent_ids = boundary === undefined ? [] : [boundary];
          room.state = "active";
        }
        // An existing live interval retains its cursor/ring/discontinuity,
        // including backlog preceding this send or another subscriber's join.
        let member = room.members.find((m) =>
          m.namespace === ns && m.session_id === session
        );
        if (!member) {
          member = {
            namespace: ns,
            session_id: session,
            joined: true,
            interest: 0,
          };
          room.members.push(member);
        }
        member.joined = true;
        member.interest = ++s.sequence;
        this.#recipient(s, room);
        return this.#view(room, member);
      });
      if (!result) continue;
      this.#changed(this.store.read());
      this.kick();
      return result;
    }
  }
  /** Ordinary calls express interest only for existing, joined memberships. */
  interest(owner: string, session?: string, chat?: number) {
    this.#auth(owner);
    if (!session) return;
    const ns = this.namespace(owner);
    this.store.write((s) => {
      for (const room of s.rooms) {
        if (chat !== undefined && room.chat_id !== chat) continue;
        const member = room.members.find((m) =>
          m.namespace === ns && m.session_id === session && m.joined
        );
        if (!member) continue;
        member.interest = ++s.sequence;
        this.#recipient(s, room);
      }
    });
    this.#changed(this.store.read());
    this.kick();
  }
  #view(room: RoutedRoom, member: RoomMember) {
    return {
      chat_id: room.chat_id,
      session_id: member.session_id,
      subscribed: member.joined,
      recipient: room.recipient === memberID(member),
      state: room.state,
      anchor_id: room.anchor_id,
      recent_ids: room.recent_ids,
    };
  }
  subscriptions(owner: string, session: string) {
    const ns = this.namespace(owner);
    const state = this.store.read();
    return {
      subscriptions: state.rooms.flatMap((room) =>
        room.members.filter((m) =>
          m.namespace === ns && m.session_id === session
        )
          .map((m) => ({
            ...this.#view(room, m),
            deliveries: state.deliveries.filter((d) =>
              d.namespace === ns && d.target_session === session &&
              d.chat_id === room.chat_id
            ).map((d) => ({
              id: d.delivery_id,
              state: d.state,
              outcome: d.outcome,
              mirror: d.mirror,
              mirror_message_id: d.mirror_message_id,
            })),
          }))
      ),
    };
  }
  leave(owner: string, session: string, chat: number) {
    const ns = this.namespace(owner);
    const result = this.store.write((s) => {
      const room = s.rooms.find((r) => r.chat_id === chat);
      const m = room?.members.find((m) =>
        m.namespace === ns && m.session_id === session
      );
      if (!room || !m) throw new Error("Subscription not found");
      const leaving = m.joined;
      m.joined = false;
      if (leaving && !room.members.some((member) => member.joined)) {
        // Explicit last leave closes this eligibility interval atomically with
        // ready-work cancellation. Already claimed work keeps its original token.
        room.interval++;
        for (const d of s.deliveries) {
          if (d.chat_id === chat && d.state === "ready") {
            d.state = "completed";
            d.outcome = "cancelled";
            d.completed_at = this.#now();
          }
        }
      }
      this.#recipient(s, room);
      return this.#view(room, m);
    });
    this.#changed(this.store.read());
    this.kick();
    return result;
  }
  async resume(owner: string, session: string, chat: number, after: number) {
    const ns = this.namespace(owner);
    await this.ports.chats.messages(chat, { afterId: after, limit: 1 });
    this.#auth(owner);
    this.store.write((s) => {
      const r = s.rooms.find((r) => r.chat_id === chat);
      if (
        !r || r.state !== "blocked_discontinuity" ||
        !r.members.some((m) =>
          m.namespace === ns && m.session_id === session && m.joined
        )
      ) throw new Error("Subscribed blocked room required");
      r.anchor_id = after;
      r.recent_ids = [after];
      r.state = "active";
    });
    this.interest(owner, session, chat);
    return this.subscriptions(owner, session);
  }
  inbox(owner: string) {
    const ns = this.namespace(owner);
    const s = this.store.read();
    const rooms = s.rooms.filter((r) =>
      r.members.some((m) => m.namespace === ns)
    );
    return {
      deliveries: s.deliveries.filter((d) => d.namespace === ns).map((d) => ({
        delivery_id: d.delivery_id,
        target_session: d.target_session,
        chat_id: d.chat_id,
        from_anchor: d.from_anchor,
        message_ids: d.message_ids,
        state: d.state,
        claimant: d.claimant,
        outcome: d.outcome,
        mirror: d.mirror,
        mirror_message_id: d.mirror_message_id,
      })),
      notices: s.notices.filter((n) =>
        rooms.some((r) => r.chat_id === n.chat_id)
      ).map((n) => ({ chat_id: n.chat_id, state: n.state })),
      rooms: rooms.map((r) => ({
        chat_id: r.chat_id,
        state: r.state,
        anchor_id: r.anchor_id,
      })),
    };
  }
  #delivery(s: RoutingMetadata, ns: string, id: string, token?: string) {
    const d = s.deliveries.find((d) =>
      d.delivery_id === id && d.namespace === ns
    );
    if (
      !d || (token !== undefined && (d.claim_token !== token || !d.claimant))
    ) {
      throw new Error("Delivery claim conflict");
    }
    return d;
  }
  claim(owner: string, id: string, claimant: string, targetSession?: string) {
    const ns = this.namespace(owner);
    const d = this.store.write((s) => {
      const d = this.#delivery(s, ns, id);
      const room = s.rooms.find((r) => r.chat_id === d.chat_id)!;
      this.#recipient(s, room);
      // A receiver's native routing identity is an expected target, not auth or
      // interest. Check it in the same transaction as ready-work reassignment.
      if (targetSession !== undefined && d.target_session !== targetSession) {
        throw new Error("Delivery target changed");
      }
      if (
        d.namespace !== ns || (d.state === "ready" &&
          (!room.recipient || room.state !== "active" ||
            d.interval !== room.interval))
      ) throw new Error("Delivery reassigned");
      if (d.state === "completed" && !d.claimant) {
        throw new Error("Delivery interval ended");
      }
      if (d.claimant && d.claimant !== claimant) {
        throw new Error("Delivery already claimed");
      }
      if (d.state === "ready") {
        d.claimant = claimant;
        d.claim_token = crypto.randomUUID();
        d.state = "claimed";
      }
      return structuredClone(d);
    });
    this.#changed(this.store.read());
    return d;
  }
  complete(owner: string, id: string, token: string, outcome: string) {
    const ns = this.namespace(owner);
    const d = this.store.write((s) => {
      const d = this.#delivery(s, ns, id, token);
      if (d.state === "completed" && d.outcome !== outcome) {
        throw new Error("Completion conflict");
      }
      d.state = "completed";
      d.outcome = outcome;
      d.completed_at ??= this.#now();
      return structuredClone(d);
    });
    this.#changed(this.store.read());
    return d;
  }
  release(owner: string, id: string, token: string) {
    const ns = this.namespace(owner);
    this.store.write((s) => {
      const d = this.#delivery(s, ns, id, token);
      if (d.state !== "claimed" || d.mirror !== "none") {
        throw new Error("Cannot release dispatched work");
      }
      d.state = "ready";
      d.claimant = null;
      d.claim_token = null;
      this.#recipient(s, s.rooms.find((r) => r.chat_id === d.chat_id)!);
      const room = s.rooms.find((r) => r.chat_id === d.chat_id)!;
      const current = room.members.find((m) => memberID(m) === room.recipient);
      if (current && d.interval === room.interval) {
        d.namespace = current.namespace;
        d.target_session = current.session_id;
      } else {
        d.state = "completed";
        d.outcome = "cancelled";
        d.completed_at = this.#now();
      }
    });
    this.#changed(this.store.read());
    return { released: true };
  }
  /** Frozen IDs are loaded through the shared full-body loader, not a body journal.
   * A token is required even for reads; these operations never express interest. */
  async bodies(owner: string, id: string, token: string) {
    const ns = this.namespace(owner);
    const d = this.#delivery(this.store.read(), ns, id, token);
    const found = new Map<number, Message>();
    let before: number | undefined;
    const visited = new Set<number>();
    while (true) {
      const page = await this.ports.chats.messages(d.chat_id, {
        beforeId: before,
        limit: 100,
      });
      for (const m of page) {
        if (d.message_ids.includes(m.id)) found.set(m.id, m);
      }
      if (found.size === d.message_ids.length || !page.length) break;
      const next = page[0].id;
      if (visited.has(next)) throw new Error("History did not progress");
      visited.add(next);
      before = next;
    }
    this.#auth(owner);
    const messages = d.message_ids.flatMap((id) =>
      found.has(id) ? [found.get(id)!] : []
    );
    await this.ports.chats.markSeen(
      messages.filter((m) => !m.fromSelf).map((m) => m.id),
    );
    this.#auth(owner);
    return { messages };
  }
  mirror(owner: string, id: string, token: string, text: string) {
    const task = this.#mirror(owner, id, token, text);
    this.#controls.add(task);
    void task.finally(() => this.#controls.delete(task)).catch(() => {});
    return task;
  }
  async #mirror(owner: string, id: string, token: string, text: string) {
    const ns = this.namespace(owner);
    const attempt = this.store.write((s) => {
      const d = this.#delivery(s, ns, id, token);
      if (d.mirror !== "none") {
        return { dispatch: false, d: structuredClone(d) };
      }
      if (d.state !== "claimed") throw new Error("Claim required");
      d.mirror = "attempting";
      return { dispatch: true, d: structuredClone(d) };
    });
    if (attempt.dispatch) {
      try {
        const sent = await this.ports.send.sendText(attempt.d.chat_id, text);
        this.store.write((s) => {
          const d = this.#delivery(s, ns, id, token);
          d.mirror = "sent";
          d.mirror_message_id = sent.messageId;
        });
      } catch {
        this.store.write((s) => {
          this.#delivery(s, ns, id, token).mirror = "uncertain";
        });
      }
      this.#changed(this.store.read());
    }
    const d = this.#delivery(this.store.read(), ns, id, token);
    return {
      chat_id: d.chat_id,
      mirror: d.mirror,
      message_id: d.mirror_message_id,
    };
  }
  kick() {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#job) return;
    clearTimeout(this.#retry);
    this.#job = Promise.resolve().then(async () => {
      try {
        while (this.#dirty && !this.#closed) {
          this.#dirty = false;
          for (const r of this.store.read().rooms) {
            if (this.#closed) break;
            await this.#scan(r);
          }
          await this.#notices();
          this.store.write((s) => this.#prune(s));
        }
      } catch {
        if (!this.#closed) this.#retry = setTimeout(() => this.kick(), 5000);
      } finally {
        // Release in the drain's last turn, not a later promise reaction that
        // could strand a new dirty hint behind an already-finished worker.
        this.#job = undefined;
      }
    });
  }
  async #scan(original: RoutedRoom) {
    if (
      original.state !== "active" || !original.members.some((m) => m.joined)
    ) return;
    const after = original.anchor_id ?? undefined;
    let page: Message[] | undefined;
    try {
      page = await this.ports.chats.routingMessages(original.chat_id, after);
    } catch (error) {
      if (!(error instanceof UnknownMessageAnchor)) throw error;
      for (const anchor of [...original.recent_ids].reverse()) {
        if (anchor === original.anchor_id) continue;
        try {
          page = await this.ports.chats.routingMessages(
            original.chat_id,
            anchor,
          );
          break;
        } catch (error) {
          if (!(error instanceof UnknownMessageAnchor)) throw error;
        }
      }
    }
    this.store.write((s) => {
      const r = s.rooms.find((r) => r.chat_id === original.chat_id)!;
      if (
        r.interval !== original.interval ||
        r.anchor_id !== original.anchor_id ||
        r.state !== "active" || !r.members.some((m) => m.joined)
      ) return;
      this.#recipient(s, r);
      if (!page) {
        r.state = "blocked_discontinuity";
        return;
      }
      if (!page.length) return;
      const ids = page.map((m) => m.id);
      const fresh = page.filter((m) => !r.recent_ids.includes(m.id));
      const human = fresh.filter(isRoomHuman).map((m) => m.id);
      const recipient = r.members.find((m) => memberID(m) === r.recipient);
      // An unavailable authorized edge is not an explicit leave. Retain backlog
      // during disconnect/revocation; a true last leave ends the interval above.
      if (!recipient) return;
      if (human.length) {
        let d = s.deliveries.find((d) =>
          d.chat_id === r.chat_id && d.interval === r.interval &&
          d.state === "ready" && d.namespace === recipient.namespace &&
          d.target_session === recipient.session_id
        );
        if (!d) {
          d = {
            delivery_id: crypto.randomUUID(),
            namespace: recipient.namespace,
            target_session: recipient.session_id,
            chat_id: r.chat_id,
            interval: r.interval,
            from_anchor: original.anchor_id,
            message_ids: [],
            state: "ready",
            claimant: null,
            claim_token: null,
            outcome: null,
            mirror: "none",
            mirror_message_id: null,
          };
          s.deliveries.push(d);
        }
        d.message_ids = [...new Set([...d.message_ids, ...human])];
      }
      r.anchor_id = ids.at(-1)!;
      r.recent_ids = [...r.recent_ids, ...fresh.map((m) => m.id)].slice(-32);
      if (page.length === 100) this.#dirty = true;
    });
    this.#changed(this.store.read());
  }
  async #notices() {
    // Only this scanner sends notices. The durable attempting row precedes I/O;
    // startup converts abandoned attempts to uncertain instead of resending.
    const pending = this.store.read().notices.filter((n) =>
      n.state === "attempting"
    );
    for (const n of pending) {
      if (this.#closed) return;
      let state: "sent" | "uncertain" = "uncertain";
      try {
        const session = n.recipient
          ? JSON.parse(n.recipient)[1] as string
          : "none";
        await this.ports.send.sendText(
          n.chat_id,
          `[delta-chat-mcp relay status] Current recipient: ${
            JSON.stringify(session)
          }.`,
        );
        state = "sent";
      } catch { /* unknown core result: visible metadata, no retry */ }
      this.store.write((s) => {
        const current = s.notices.find((row) =>
          row.chat_id === n.chat_id && row.recipient === n.recipient &&
          row.state === "attempting"
        );
        if (current) {
          current.state = state;
          current.completed_at = this.#now();
        }
      });
    }
  }
  async close() {
    this.#closed = true;
    this.#off();
    clearTimeout(this.#retry);
    await this.#job;
    await Promise.allSettled([...this.#controls]);
    this.#listeners.clear();
  }
}
