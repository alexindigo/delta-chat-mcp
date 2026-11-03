// SPDX-License-Identifier: LGPL-3.0-only
import { setTimeout as delay } from "node:timers/promises";
import {
  classifyCompletion,
  isNativeInput,
  type NativeAnswer,
} from "./completion.ts";
import type { OpenCode } from "./opencode.ts";
import type { Registry } from "./registry.ts";
import { type Relay, RelayFailure } from "./relay.ts";
import {
  type Delivery,
  isTerminalDelivery,
  object,
  type RelayMessage,
  type Submission,
  type Subscription,
} from "./types.ts";
import { wakePrompt } from "./wake-prompt.ts";
import type { OwnerProcess } from "./owner-witness.ts";

export type DispatchRelay = Pick<
  Relay,
  "read" | "call" | "identity" | "refreshNativeState"
>;
export interface DispatcherPorts {
  registry(): Registry;
  opencode: OpenCode;
  relays: ReadonlyMap<string, DispatchRelay>;
  owner: string;
  directory: string;
  holder: string;
  epoch: string;
  process?: OwnerProcess;
  signal: AbortSignal;
  // J5 consumes native references, never an assertion of transport delivery.
  answerReady?(delivery: Delivery, answer: NativeAnswer): Promise<void>;
  // Modern inbox reads carry no agent session metadata/interest.
  bodies?(delivery: Delivery): Promise<RelayMessage[] | undefined>;
  settled?(): void;
  enabled?(alias: string): boolean;
  enabledDelivery?(delivery: Delivery): boolean;
  transport?(
    delivery: Delivery,
  ): Promise<
    { alias: string; relay: DispatchRelay; current(): boolean } | undefined
  >;
}

/** One serialized admission/reconciliation owner per native session. Events are
 * hints; committed routing and the native transcript are authoritative. */
export class Dispatcher {
  #jobs = new Map<string, Promise<void>>();
  #dirty = new Set<string>();
  #errors = new Map<string, number>();
  #idle = new Map<string, number>();
  #closed = false;
  #backstop?: ReturnType<typeof setTimeout>;
  #backstopAt?: number;
  #fallbackAt?: number;
  #leaseDeadlines = new Map<string, number>();
  #notices = new Set<Promise<void>>();
  #uncertainNotices = new Set<string>();
  constructor(private readonly ports: DispatcherPorts) {}
  all() {
    if (this.#closed || this.ports.signal.aborted) return;
    try {
      for (const row of this.ports.registry().subscriptions()) {
        if (
          row.owner_server === this.ports.owner &&
          row.directory === this.ports.directory
        ) this.kick(row.session_id);
      }
    } catch {
      /* Registry unavailable; successful sends report NOT recorded. */
    }
  }
  /** Return the accepted session decision even without a local delivery, so the
   * composition can reconcile server-ready work through this same filter. */
  event(input: unknown): string | undefined {
    if (this.#closed || this.ports.signal.aborted) return;
    try {
      const event = object(object(input).event);
      const decisionEvents = [
        "session.idle",
        "session.status",
        "session.error",
        "session.updated",
        "session.deleted",
        "session.created",
      ];
      if (
        !decisionEvents.includes(String(event.type)) &&
        event.type !== "message.updated"
      ) return;
      const props = object(event.properties);
      if (
        event.type === "message.updated" &&
        (!props.info || object(props.info).role !== "user")
      ) return;
      const session = props.sessionID ??
        (props.info && object(props.info).sessionID) ??
        (props.part && object(props.part).sessionID) ??
        (typeof event.type === "string" && event.type.startsWith("session.") &&
            props.info
          ? object(props.info).id
          : undefined);
      if (typeof session !== "string") return;
      if (event.type === "session.error") this.#errors.set(session, Date.now());
      if (event.type === "session.idle") this.#idle.set(session, Date.now());
      this.kick(session);
      return session;
    } catch { /* Unknown hints are not durable acknowledgements. */ }
  }
  kick(session: string) {
    if (this.#closed || this.ports.signal.aborted) return;
    this.#dirty.add(session);
    if (this.#jobs.has(session)) return;
    const job = Promise.resolve().then(async () => {
      try {
        while (
          this.#dirty.delete(session) && !this.#closed &&
          !this.ports.signal.aborted
        ) {
          await this.#reconcile(session);
        }
      } catch {
        if (!this.ports.signal.aborted) {
          await this.notify(
            "delta-chat-mcp: wake reconciliation pending; inspect room subscriptions.",
          );
        }
      } finally {
        // Release before settling, so the next accepted event owns a new drain.
        this.#jobs.delete(session);
        this.#scheduleBackstop();
      }
    });
    this.#jobs.set(session, job);
  }
  #scheduleBackstop() {
    if (this.#closed || this.ports.signal.aborted) return;
    try {
      const pending = this.ports.registry().deliveries().filter((d) =>
        !isTerminalDelivery(d.state)
      );
      const sessions = new Set(pending.map((d) => d.session_id));
      for (const session of this.#leaseDeadlines.keys()) {
        if (!sessions.has(session)) this.#leaseDeadlines.delete(session);
      }
      if (!pending.length) {
        clearTimeout(this.#backstop);
        this.#backstop = undefined;
        this.#backstopAt = undefined;
        this.#fallbackAt = undefined;
        return;
      }
      const now = Date.now();
      this.#fallbackAt ??= now + 300_000;
      let due = this.#fallbackAt;
      for (const expiry of this.#leaseDeadlines.values()) {
        due = Math.min(due, expiry);
      }
      if (this.#backstop && this.#backstopAt === due) return;
      clearTimeout(this.#backstop);
      this.#backstopAt = due;
      this.#backstop = setTimeout(() => {
        this.#backstop = undefined;
        this.#backstopAt = undefined;
        if (this.#fallbackAt !== undefined && this.#fallbackAt <= Date.now()) {
          this.#fallbackAt = undefined;
        }
        // Expiry is a reconciliation hint, never permission to steal or submit.
        this.all();
      }, Math.max(0, due - now));
    } catch { /* no registry */ }
  }
  #subscription(d: Delivery) {
    return this.ports.registry().subscriptions(d.session_id).find((s) =>
      s.relay === d.relay && s.chat_id === d.chat_id
    );
  }
  #delivery(id: string) {
    return this.ports.registry().deliveries().find((d) => d.id === id)!;
  }
  #eligible(s: Subscription) {
    return s.owner_server === this.ports.owner &&
      s.directory === this.ports.directory;
  }
  #lease(session: string) {
    this.ports.signal.throwIfAborted();
    if (this.#closed) return false;
    const result = this.ports.registry().write((tx) =>
      tx.tryAcquireLease(
        session,
        this.ports.holder,
        this.ports.owner,
        Date.now(),
        90_000,
        this.ports.process,
      )
    );
    if (!result.acquired && result.retryAt !== null) {
      this.#leaseDeadlines.set(session, result.retryAt);
    } else this.#leaseDeadlines.delete(session);
    return result.acquired;
  }
  #end(
    d: Delivery,
    state:
      | "failed"
      | "aborted"
      | "stalled"
      | "source_deleted"
      | "superseded_by_native_input"
      | "interrupted_unanswered",
    native: string | null = null,
  ) {
    this.ports.signal.throwIfAborted();
    const reason = state === "superseded_by_native_input"
      ? "native_input"
      : state === "source_deleted"
      ? "source_deleted"
      : state === "failed"
      ? "model_error"
      : state === "stalled"
      ? "continuations_exhausted"
      : "interrupted";
    this.ports.registry().write((tx) =>
      tx.transition(d.id, d.state, state, Date.now(), reason, native)
    );
    void this.notify(`delta-chat-mcp: delivery ${d.id} ${state}.`);
    this.ports.settled?.();
  }
  #cancelLeft(d: Delivery, absent?: Submission) {
    this.ports.signal.throwIfAborted();
    return this.ports.registry().write((tx) => {
      const s = tx.subscription(d);
      if (!s || !this.#eligible(s) || !["left", "orphaned"].includes(s.state)) {
        return false;
      }
      const current = this.ports.registry().submissions(d.id).at(-1);
      if (
        current && (!absent || current.message_id !== absent.message_id ||
          current.submit_epoch === this.ports.epoch ||
          this.ports.registry().execution(d.id, current.ordinal)?.observedAt !=
            null)
      ) return false;
      tx.transition(d.id, d.state, "cancelled", Date.now(), "left");
      this.ports.settled?.();
      return true;
    });
  }
  async #reconcile(session: string) {
    const registry = this.ports.registry();
    const subscriptions = registry.subscriptions(session).filter((s) =>
      this.#eligible(s)
    );
    const entries = registry.deliveries(session).filter((d) =>
      !isTerminalDelivery(d.state) &&
      subscriptions.some((s) => s.relay === d.relay && s.chat_id === d.chat_id)
    );
    const unfinished = entries.filter((d) =>
      !registry.execution(d.id, d.continuations)?.answerID &&
      (registry.submissions(d.id).length > 0 || this.#enabled(d))
    );
    // No native execution work: no lease fsync, session lookup or transcript GET.
    // J5's repeated callback remains registry-driven and owns its transport guard.
    if (!unfinished.length) {
      for (const d of entries) await this.#answerReady(d);
      return;
    }
    if (!subscriptions.length || !this.#lease(session)) return;
    const info = await this.ports.opencode.session(session);
    this.ports.signal.throwIfAborted();
    if (!info) {
      registry.write((tx) => {
        for (const row of subscriptions) {
          if (row.state !== "left") {
            tx.putSubscription({
              ...row,
              state: "orphaned",
              updated_at: Date.now(),
            });
          }
        }
      });
      for (const original of unfinished) {
        const d = this.#delivery(original.id);
        const submission = registry.submissions(d.id).at(-1);
        if (!submission) {
          this.#cancelLeft(d);
        } else if (
          submission.submit_epoch !== this.ports.epoch &&
          registry.execution(d.id, submission.ordinal)?.observedAt == null &&
          await this.#confirm(d, submission, false) === "absent"
        ) {
          this.#cancelLeft(d, submission);
        }
      }
      return;
    }
    // Reconcile every potentially dispatched original BEFORE selecting any room.
    // A later-created uncertain original also reserves the execution slot.
    for (const delivery of unfinished) {
      let d = this.#delivery(delivery.id);
      const s = this.#subscription(d)!;
      let submission = registry.submissions(d.id).at(-1);
      if (!submission && (s.state === "left" || s.state === "orphaned")) {
        this.#cancelLeft(d);
        continue;
      }
      if (submission && submission.state !== "admitted") {
        const confirmation = await this.#confirm(d, submission, false);
        d = this.#delivery(d.id);
        submission = registry.submissions(d.id).at(-1)!;
        if (
          confirmation === "absent" &&
          submission.submit_epoch !== this.ports.epoch &&
          registry.execution(d.id, submission.ordinal)?.observedAt == null &&
          (s.state === "left" || s.state === "orphaned")
        ) {
          this.#cancelLeft(d, submission);
          continue;
        }
        if (
          confirmation === "absent" &&
          (this.#errors.get(session) ?? -1) >= submission.created_at &&
          submission.submit_epoch === this.ports.epoch &&
          submission.state !== "admission_failed"
        ) {
          registry.write((tx) =>
            tx.updateSubmission({
              ...submission!,
              state: "admission_failed",
              updated_at: Date.now(),
            })
          );
          d = this.#delivery(d.id);
          submission = registry.submissions(d.id).at(-1)!;
        }
      }
    }
    const status = await this.ports.opencode.status();
    this.ports.signal.throwIfAborted();
    if ((status[session] && status[session].type !== "idle") || info.revert) {
      return;
    }
    const rows = await this.ports.opencode.messages(session);
    const reservations = new Set<string>();
    const candidates: {
      delivery: Delivery;
      subscription: Subscription;
      ordinal: number;
      retry?: Submission;
    }[] = [];
    for (const original of registry.deliveries(session)) {
      if (isTerminalDelivery(original.state)) continue;
      const d = this.#delivery(original.id);
      const s = this.#subscription(d);
      if (!s || !this.#eligible(s)) continue;
      const submission = registry.submissions(d.id).at(-1);
      if (submission?.state === "admitted") {
        const execution = registry.execution(d.id, submission.ordinal);
        if (execution?.answerID) {
          await this.#answerReady(d);
          continue;
        }
        const result = classifyCompletion({
          rows,
          wakeID: submission.message_id,
          submitEpoch: submission.submit_epoch,
          epoch: this.ports.epoch,
          continuations: d.continuations,
          storedAt: submission.updated_at,
          sessionError:
            (this.#errors.get(session) ?? -1) >= submission.created_at,
        });
        if (result.kind === "answer") {
          this.ports.signal.throwIfAborted();
          registry.write((tx) =>
            tx.recordAnswer(
              d.id,
              submission!.ordinal,
              result.answer,
              Date.now(),
            )
          );
          this.ports.settled?.();
          await this.#answerReady(d);
          continue;
        }
        // Do not classify the tiny persist→loop-start gap as interruption. A real
        // idle hint, an assistant/error, or a changed epoch establishes the end.
        const ended = result.kind === "superseded_by_native_input" ||
          (this.#idle.get(session) ?? -1) >= submission.updated_at ||
          submission.submit_epoch !== this.ports.epoch || rows.some((r) =>
            r.info.parentID === submission!.message_id
          ) ||
          Date.now() - submission.updated_at >= 30_000;
        if (!ended) {
          reservations.add(d.id);
          continue;
        }
        if (result.kind !== "continuation") {
          this.#end(
            d,
            result.kind,
            result.kind === "superseded_by_native_input"
              ? result.messageID
              : null,
          );
          continue;
        }
        if (s.state === "left" || s.state === "orphaned") {
          this.#end(d, "stalled");
          continue;
        }
        // Eligibility for a repair turn is not execution in flight. If this
        // room cannot dispatch, other ready rooms retain the session slot.
        candidates.push({
          delivery: d,
          subscription: s,
          ordinal: submission.ordinal + 1,
        });
        continue;
      }
      if (submission) {
        if (registry.execution(d.id, submission.ordinal)?.observedAt != null) {
          reservations.add(d.id);
          continue;
        }
        // Same-process negatives never authorize resubmission, even after an error.
        if (submission.submit_epoch === this.ports.epoch) {
          reservations.add(d.id);
          continue;
        }
        const context = registry.execution(d.id, submission.ordinal);
        const index = context?.boundaryID
          ? rows.findIndex((r) => r.info.id === context.boundaryID)
          : -1;
        const native = rows.slice(index + 1).find(isNativeInput);
        if (native) {
          this.#end(d, "superseded_by_native_input", native.info.id);
          continue;
        }
        if (submission.attempts >= 3) {
          this.#end(d, "failed");
          continue;
        }
      }
      candidates.push({
        delivery: d,
        subscription: s,
        ordinal: submission?.ordinal ?? 0,
        retry: submission,
      });
    }
    for (const candidate of candidates) {
      const { delivery: d, subscription: s, ordinal, retry } = candidate;
      if (reservations.size) continue;
      if (s.state !== "active" || !this.#enabled(d)) continue;
      const transport = this.ports.transport
        ? await this.ports.transport(d)
        : undefined;
      if (this.ports.transport && !transport) continue;
      const relay = transport?.relay ?? this.ports.relays.get(s.alias);
      if (!relay) continue;
      try {
        if (!await relay.refreshNativeState()) continue;
        const result = await this.#submit(
          d,
          transport ? { ...s, alias: transport.alias } : s,
          relay,
          ordinal,
          retry,
          transport?.current,
        );
        if (result === "reserved" || result === "session_deferred") return;
      } catch (error) {
        if (this.ports.signal.aborted || !(error instanceof RelayFailure)) {
          throw error;
        }
        // Repeatable room/edge errors never reserve another room's native slot.
      }
    }
  }
  #enabled(d: Delivery): boolean {
    if (this.ports.enabledDelivery) return this.ports.enabledDelivery(d);
    const s = this.#subscription(d);
    return !!s && (this.ports.enabled?.(s.alias) ?? true);
  }
  async #answerReady(d: Delivery) {
    const execution = this.ports.registry().execution(d.id, d.continuations);
    if (!execution?.answerID || !this.ports.answerReady) return;
    try {
      await this.ports.answerReady(d, {
        messageID: execution.answerID,
        partIDs: execution.partIDs,
      });
    } catch (error) {
      if (this.ports.signal.aborted || !(error instanceof RelayFailure)) {
        throw error;
      }
    }
  }
  async #confirm(
    d: Delivery,
    s: Submission,
    bounded: boolean,
  ): Promise<"absent" | "present" | "confirmed"> {
    let present =
      this.ports.registry().execution(d.id, s.ordinal)?.observedAt != null;
    for (let attempt = 0; attempt < (bounded ? 20 : 1); attempt++) {
      const lookup = await this.ports.opencode.lookupMessage(
        d.session_id,
        s.message_id,
      );
      this.ports.signal.throwIfAborted();
      if (lookup.exists) {
        this.ports.registry().write((tx) =>
          tx.observeNativeID(d.id, s.ordinal, Date.now())
        );
        present = true;
      }
      const found = lookup.exists ? lookup.message : undefined;
      const part = found?.parts.find((p) => p.id === s.part_id);
      const metadata = part?.metadata?.deltaChatWake;
      const facts =
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? object(metadata)
          : undefined;
      if (
        found?.info.id === s.message_id && found.info.role === "user" &&
        (found.info.sessionID === undefined ||
          found.info.sessionID === d.session_id) &&
        facts?.v === 1 && facts.deliveryId === d.id &&
        facts.relay === d.relay && facts.chatId === d.chat_id &&
        JSON.stringify(facts.messageIds) === JSON.stringify(d.message_ids) &&
        facts.continuationOf ===
          (s.ordinal > 0
            ? this.ports.registry().submissions(d.id)[s.ordinal - 1]?.message_id
            : undefined)
      ) {
        this.ports.registry().write((tx) =>
          tx.updateSubmission({
            ...s,
            state: "admitted",
            updated_at: Date.now(),
          })
        );
        return "confirmed";
      }
      if (bounded) await delay(250, undefined, { signal: this.ports.signal });
    }
    return present ? "present" : "absent";
  }
  async #bodies(d: Delivery, relay: DispatchRelay) {
    if (this.ports.bodies) return await this.ports.bodies(d);
    const found = new Map<
      number,
      Awaited<ReturnType<Relay["read"]>>["messages"][number]
    >();
    let after: number | undefined = d.from_anchor;
    let before: number | undefined;
    let backwards = false;
    const visited = new Set<number>();
    while (true) {
      let page;
      try {
        page = (await relay.read(d.chat_id, after, this.ports.signal, before))
          .messages;
      } catch (error) {
        if (
          !backwards && error instanceof RelayFailure &&
          error.reason === "not_found"
        ) {
          backwards = true;
          after = undefined;
          visited.clear();
          continue;
        }
        throw error;
      }
      for (const message of page) {
        if (d.message_ids.includes(message.id)) {
          found.set(message.id, message);
        }
      }
      if (found.size === d.message_ids.length) {
        return d.message_ids.map((id) => found.get(id)!);
      }
      if (!page.length) {
        if (backwards) return undefined;
        // Absence after the old anchor alone is not proof of local deletion.
        // Exhaust the other direction too, by actual before_id pagination.
        backwards = true;
        after = undefined;
        visited.clear();
        continue;
      }
      const next = backwards ? page[0].id : page.at(-1)!.id;
      if (visited.has(next)) {
        throw new Error("History pagination did not progress");
      }
      visited.add(next);
      if (backwards) before = next;
      else after = next;
    }
  }
  async #submit(
    d: Delivery,
    s: Subscription,
    relay: DispatchRelay,
    ordinal: number,
    retry?: Submission,
    ready?: () => boolean,
  ): Promise<"reserved" | "room_deferred" | "session_deferred" | "finished"> {
    if (await relay.identity(this.ports.signal) !== d.relay) {
      return "room_deferred";
    }
    const bodies = await this.#bodies(d, relay);
    if (!bodies) {
      this.#end(d, "source_deleted");
      return "finished";
    }
    const chats = object(await relay.call("list_chats", {}, this.ports.signal));
    const list = Array.isArray(chats.chats) ? chats.chats : [];
    const chat = list.map(object).find((chat) => chat.id === d.chat_id);
    const text = wakePrompt(
      s,
      typeof chat?.name === "string" ? chat.name : `chat ${d.chat_id}`,
      bodies,
      ordinal > 0,
    );
    if (!await relay.refreshNativeState()) return "room_deferred";
    const latestRows = await this.ports.opencode.messages(d.session_id);
    const status = await this.ports.opencode.status();
    const currentInfo = await this.ports.opencode.session(d.session_id);
    if (
      !currentInfo || currentInfo.revert ||
      (status[d.session_id] && status[d.session_id].type !== "idle")
    ) return "session_deferred";
    if (retry && await this.#confirm(d, retry, false) !== "absent") {
      return "reserved";
    }
    this.ports.signal.throwIfAborted();
    if (this.#closed) return "session_deferred";
    if (!this.#enabled(d) || ready && !ready()) return "room_deferred";
    if (!this.#lease(d.session_id)) return "session_deferred";
    const current = this.#subscription(d);
    if (!current || current.state !== "active" || !this.#eligible(current)) {
      return "room_deferred";
    }
    if (
      JSON.stringify(this.#delivery(d.id).message_ids) !==
        JSON.stringify(d.message_ids)
    ) {
      this.#dirty.add(d.session_id);
      return "room_deferred";
    }
    const selection = this.ports.opencode.selection(
      currentInfo,
      latestRows.findLast((r) => r.info.role === "user"),
    );
    // All awaited preparation ends before this durable allocation + first POST.
    const submitted = this.ports.registry().write((tx) => {
      if (retry) {
        const next: Submission = {
          ...retry,
          submit_epoch: this.ports.epoch,
          attempts: retry.attempts + 1,
          state: "submitting",
          updated_at: Date.now(),
        };
        tx.updateSubmission(next);
        return next;
      }
      return tx.allocateSubmission(
        d.id,
        this.ports.epoch,
        ordinal,
        Date.now(),
        latestRows.findLast(isNativeInput)?.info.id ?? null,
      );
    });
    try {
      await this.ports.opencode.submit(d.session_id, {
        messageID: submitted.message_id,
        partID: submitted.part_id,
        text,
        selection,
        metadata: {
          deltaChatWake: {
            v: 1,
            deliveryId: d.id,
            relay: d.relay,
            chatId: d.chat_id,
            messageIds: d.message_ids,
            ...(ordinal > 0 ? { continuationOf: d.user_message_id } : {}),
          },
        },
      });
      this.ports.signal.throwIfAborted();
      this.ports.registry().write((tx) =>
        tx.updateSubmission({
          ...submitted,
          state: "submitted",
          updated_at: Date.now(),
        })
      );
      if (
        await this.#confirm(d, { ...submitted, state: "submitted" }, true) !==
          "confirmed"
      ) {
        this.#uncertain(d.id);
      }
    } catch {
      if (this.ports.signal.aborted) return "reserved";
      // A POST error is not proof its fork cannot persist. Never retry here.
      const latest = this.ports.registry().submissions(d.id).at(-1)!;
      if (latest.state !== "admitted") {
        this.ports.registry().write((tx) =>
          tx.updateSubmission({
            ...latest,
            state: "admission_failed",
            updated_at: Date.now(),
          })
        );
        this.#uncertain(d.id);
      }
    }
    return "reserved";
  }
  #uncertain(id: string) {
    if (this.#uncertainNotices.has(id)) return;
    this.#uncertainNotices.add(id);
    void this.notify(
      `delta-chat-mcp: delivery ${id} native admission is uncertain; stable IDs remain in local progress, and this process will not resubmit it blindly.`,
    );
  }
  notice(row: Subscription) {
    return this.notify(
      `delta-chat-mcp: room ${row.chat_id} blocked_discontinuity at lost anchor ${row.anchor_id}; inspect subscriptions and explicitly use delta_chat_room_resume.`,
    );
  }
  /** Control-plane health never enters the native user-input/admission channel.
   * Durable facts live in the registry/list tool; J5 reuses this toast owner. */
  notify(message: string) {
    if (this.#closed || this.ports.signal.aborted) return Promise.resolve();
    const task = this.ports.opencode.toast(message).catch(() => {});
    this.#notices.add(task);
    void task.finally(() => this.#notices.delete(task));
    return task;
  }
  /** Synchronous admission boundary; uncertain native work retains its lease. */
  fence(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#backstop);
    this.#backstop = undefined;
    this.#backstopAt = undefined;
    this.#fallbackAt = undefined;
    this.#leaseDeadlines.clear();
    try {
      this.ports.registry().write((tx) =>
        tx.releaseIdleLeases(this.ports.holder)
      );
    } catch {
      /* Unknown/read/transaction failure keeps ownership until expiry. */
    }
  }
  async close() {
    this.fence();
    await Promise.allSettled([...this.#jobs.values(), ...this.#notices]);
    let rows: Subscription[];
    try {
      rows = this.ports.registry().subscriptions();
    } catch {
      return;
    }
    for (const row of rows) {
      this.ports.registry().write((tx) =>
        tx.releaseLease(row.session_id, this.ports.holder)
      );
    }
  }
}
