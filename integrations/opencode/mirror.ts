// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { answerText, wakeAssistants } from "./completion.ts";
import { sanitizedAlias } from "./options.ts";
import type { OpenCode } from "./opencode.ts";
import type { Registry } from "./registry.ts";
import { type Relay, RelayFailure } from "./relay.ts";
import {
  type Delivery,
  isTerminalDelivery,
  object,
  positiveID,
  type RelayScope,
  type Subscription,
} from "./types.ts";

// Like the admission epoch, live claims span artifact URLs in the pinned main
// isolate. Durable state remains authoritative; a dead claim is never resent.
const liveKey = Symbol.for("delta-chat-mcp.opencode-wake.mirror-claims.v1");
if (!Object.hasOwn(globalThis, liveKey)) {
  Object.defineProperty(globalThis, liveKey, {
    value: new Set<string>(),
    writable: false,
    configurable: false,
  });
}
const live = Object.getOwnPropertyDescriptor(globalThis, liveKey)!.value as Set<
  string
>;
export async function fingerprint(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export interface MirrorPorts {
  registry(): Registry;
  opencode: Pick<OpenCode, "message" | "messages">;
  relays: ReadonlyMap<
    string,
    Pick<Relay, "send" | "call" | "refreshNativeState" | "health">
  >;
  owner: string;
  directory: string;
  epoch: string;
  signal: AbortSignal;
  notify(message: string): Promise<void>;
  sendFinal?(
    delivery: Delivery,
    text: string,
  ): Promise<{ chat_id: number; message_id: number }>;
  settled?(): void;
  enabled?(alias: string): boolean;
  transport?(
    delivery: Delivery,
  ): Promise<
    {
      relay: Pick<Relay, "send" | "call" | "refreshNativeState" | "health">;
      current(): boolean;
    } | undefined
  >;
}

/** Transport delivery never occupies the session's native execution slot.
 * Every asynchronous consumer is joined before relay/registry disposal. */
export class Mirror {
  #jobs = new Map<string, Promise<void>>();
  #observations = new Set<Promise<void>>();
  #timer?: ReturnType<typeof setTimeout>;
  #closed = false;
  constructor(private readonly ports: MirrorPorts) {}
  /** Called by the proxy only AFTER permission. Bind before network dispatch to
   * the actual native assistant/tool part in this wake; never outgoing history. */
  async prepareSend(
    alias: string,
    scope: RelayScope,
    args: Record<string, unknown>,
    context: Record<string, unknown>,
  ) {
    if (typeof args.text !== "string" || typeof args.chat_id !== "number") {
      return [];
    }
    const registry = this.ports.registry();
    const candidates = registry.deliveries(String(context.sessionID)).filter((
      d,
    ) =>
      ["admitted", "submitted", "submitting"].includes(d.state) &&
      this.#binding(d) &&
      d.chat_id === args.chat_id && d.relay === scope.identity
    );
    // Explicit model sends use their own permission-approved, validated scope.
    // Another key may send to this same identity/room; observing that attempt
    // never authorizes it as the wake's frozen background claim transport.
    if (!candidates.length) return [];
    if (typeof context.messageID !== "string") {
      throw new Error("Native send context unavailable");
    }
    const rows = await this.ports.opencode.messages(String(context.sessionID));
    const nativeContext = rows.find((r) => r.info.id === context.messageID);
    if (
      !nativeContext || nativeContext.info.role !== "assistant" ||
      (nativeContext.info.sessionID !== undefined &&
        nativeContext.info.sessionID !== context.sessionID)
    ) {
      throw new Error("Native send context unavailable");
    }
    const hash = await fingerprint(args.text);
    this.ports.signal.throwIfAborted();
    const attempts: string[] = [];
    let wakeOwned = false;
    for (const d of candidates) {
      const submission = registry.submissions(d.id).at(-1);
      const wake = rows.find((r) => r.info.id === submission?.message_id);
      const facts = wake?.parts.find((p) => p.id === submission?.part_id)
        ?.metadata?.deltaChatWake;
      if (
        !submission || !facts || object(facts).deliveryId !== d.id ||
        object(facts).relay !== d.relay || object(facts).chatId !== d.chat_id
      ) continue;
      const row = wakeAssistants(rows, submission.message_id).find((r) =>
        r.info.id === context.messageID &&
        (r.info.sessionID === undefined ||
          r.info.sessionID === context.sessionID)
      );
      if (row) wakeOwned = true;
      const parts = row?.parts.filter((p) =>
        p.type === "tool" &&
        p.tool === `${sanitizedAlias(alias)}_send_message` &&
        object(p.state).status === "running" &&
        (typeof context.callID === "string"
          ? p.callID === context.callID
          : object(object(p.state).input).chat_id === args.chat_id)
      ) ?? [];
      if (!row || parts.length !== 1 || typeof parts[0].callID !== "string") {
        continue;
      }
      attempts.push(
        registry.beginModelAttempt(d.id, {
          messageID: row.info.id,
          partID: parts[0].id,
          callID: parts[0].callID,
          fingerprint: hash,
        }),
      );
    }
    if (wakeOwned && !attempts.length) {
      throw new Error("Native send wake binding unavailable");
    }
    return attempts;
  }
  settleSend(attempts: string[], result?: unknown, error?: unknown) {
    const registry = this.ports.registry();
    let status: "sent" | "uncertain" | "not_dispatched" = "uncertain",
      coreID: number | undefined,
      chatID: number | undefined;
    if (
      error instanceof RelayFailure &&
      (error.retrySafe || error.domain === "guard")
    ) status = "not_dispatched";
    if (result && !object(result).isError) {
      try {
        const value = object(result);
        const raw = value.structuredContent ??
          JSON.parse(
            z.array(z.object({ type: z.string(), text: z.string().optional() }))
              .parse(value.content).find((p) => p.type === "text")?.text ??
              "null",
          );
        coreID = positiveID.parse(object(raw).message_id);
        chatID = positiveID.parse(object(raw).chat_id);
        status = "sent";
      } catch { /* no positive core ID: retain uncertainty */ }
    }
    for (const attempt of attempts) {
      registry.finishModelAttempt(attempt, status, coreID, chatID);
    }
  }
  #binding(d: Delivery): Subscription | undefined {
    return this.ports.registry().subscriptions(d.session_id).find((s) =>
      s.relay === d.relay && s.chat_id === d.chat_id &&
      s.owner_server === this.ports.owner &&
      s.directory === this.ports.directory
    );
  }
  all() {
    if (this.#closed || this.ports.signal.aborted) return;
    try {
      for (const d of this.ports.registry().deliveries()) {
        if (
          !isTerminalDelivery(d.state) && this.#binding(d) &&
          (d.state === "mirroring" ||
            this.ports.registry().execution(d.id, d.continuations)?.answerID)
        ) this.ready(d);
      }
    } catch { /* successful sends own unavailable-storage feedback */ }
  }
  ready(d: Delivery): Promise<void> {
    if (this.#closed || this.ports.signal.aborted || this.#jobs.has(d.id)) {
      return Promise.resolve();
    }
    const task = Promise.resolve().then(() => this.#deliver(d.id)).catch(
      async () => {
        // No raw native content/errors/credentials enter control-plane health.
        if (!this.ports.signal.aborted) {
          await this.ports.notify(
            `delta-chat-mcp: delivery ${d.id} mirror pending; inspect subscriptions.`,
          );
        }
      },
    ).finally(() => {
      this.#jobs.delete(d.id);
      this.#schedule();
    });
    this.#jobs.set(d.id, task);
    // Intentionally acknowledge scheduling, not network completion.
    return Promise.resolve();
  }
  #schedule() {
    if (this.#closed || this.ports.signal.aborted || this.#timer) return;
    const registry = this.ports.registry();
    const waiting = registry.deliveries().filter((d) =>
      d.state === "admitted" &&
      this.#binding(d) && registry.execution(d.id, d.continuations)?.answerID
    );
    if (!waiting.length) return;
    const next = Math.min(
      ...waiting.map((d) =>
        registry.mirrorProgress(d.id)?.retryAt || Date.now() + 10_000
      ),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.all();
    }, Math.max(1000, next - Date.now()));
  }
  async #finish(
    d: Delivery,
    token: string | null,
    state:
      | "mirrored"
      | "mirror_uncertain"
      | "mirror_failed"
      | "answered_by_model"
      | "empty",
    ids: number[] = [],
  ) {
    const changed = this.ports.registry().write((tx) =>
      tx.finishMirror(d.id, token, state, Date.now(), ids)
    );
    if (changed) this.ports.settled?.();
    if (
      changed &&
      ["mirror_uncertain", "mirror_failed", "empty"].includes(state) &&
      !this.ports.signal.aborted
    ) {
      await this.ports.notify(
        `delta-chat-mcp: delivery ${d.id} ${state}; intended answer remains in the native transcript. Inspect subscriptions and the room before any explicit send.`,
      );
    }
  }
  async #deliver(id: string) {
    const registry = this.ports.registry();
    const d = registry.deliveries().find((d) => d.id === id);
    if (!d || isTerminalDelivery(d.state)) return;
    const s = this.#binding(d);
    if (
      !s || !this.ports.transport && this.ports.enabled?.(s.alias) === false
    ) return;
    const previous = registry.mirrorProgress(id);
    if (d.state === "mirroring") {
      if (
        previous?.claim && previous.epoch === this.ports.epoch &&
        live.has(previous.claim)
      ) return;
      await this.#finish(d, previous?.claim ?? null, "mirror_uncertain");
      return;
    }
    if (d.state !== "admitted" || (previous && previous.retryAt > Date.now())) {
      return;
    }
    const execution = registry.execution(id, d.continuations);
    if (!execution?.answerID) return;
    const row = await this.ports.opencode.message(
      d.session_id,
      execution.answerID,
    );
    this.ports.signal.throwIfAborted();
    if (
      !row ||
      (row.info.sessionID !== undefined && row.info.sessionID !== d.session_id)
    ) return;
    const text = answerText(row, {
      messageID: execution.answerID,
      partIDs: execution.partIDs,
    });
    if (!text.trim()) {
      await this.#finish(d, null, "empty");
      return;
    }
    const hash = await fingerprint(text);
    const self = registry.modelSends(id).filter((send) =>
      send.fingerprint === hash
    );
    if (self.length) {
      await this.#finish(d, null, "answered_by_model", [
        ...new Set(self.map((send) => send.coreID)),
      ]);
      return;
    }
    const modelOutcome = async () => {
      const attempts = registry.modelAttempts(id).filter((a) =>
        a.fingerprint === hash
      );
      if (
        attempts.some((a) => a.status === "pending" || a.status === "uncertain")
      ) {
        await this.#finish(d, null, "mirror_uncertain");
        return true;
      }
      const sent = attempts.filter((a) =>
        a.status === "sent" && a.coreID !== null
      );
      if (sent.length) {
        await this.#finish(d, null, "answered_by_model", [
          ...new Set(sent.map((a) => a.coreID!)),
        ]);
        return true;
      }
      return false;
    };
    if (await modelOutcome()) return;
    const transport = this.ports.transport
      ? await this.ports.transport(d)
      : undefined;
    if (this.ports.transport && !transport) return;
    const relay = transport?.relay ?? this.ports.relays.get(s.alias);
    if (!relay || s.state === "paused" || s.state === "unroutable") return;
    // Canonical facts, not a historical identity cache or an alternative alias.
    if (!await relay.refreshNativeState()) return;
    const identity = object(await relay.call("status", {}, this.ports.signal));
    if (identity.address !== d.relay) return;
    const chats = object(await relay.call("list_chats", {}, this.ports.signal));
    if (
      !Array.isArray(chats.chats) ||
      !chats.chats.some((chat) => object(chat).id === d.chat_id)
    ) return;
    this.ports.signal.throwIfAborted();
    if (transport && !transport.current()) return;
    if (await modelOutcome()) return;
    const token = crypto.randomUUID();
    live.add(token);
    try {
      if (
        !registry.write((tx) =>
          tx.claimMirror(id, s, token, this.ports.epoch, Date.now(), hash)
        )
      ) return;
      try {
        const sent = this.ports.sendFinal
          ? await this.ports.sendFinal(d, text)
          : await relay.send(d.chat_id, text, this.ports.signal);
        // Even if disposal won, an accepted post remains accepted.
        if (sent.chat_id !== d.chat_id) {
          await this.#finish(d, token, "mirror_uncertain");
          return;
        }
        await this.#finish(d, token, "mirrored", [sent.message_id]);
      } catch (error) {
        const guarded = error instanceof RelayFailure &&
          error.domain === "guard" &&
          ["paused", "cancelled"].includes(error.kind);
        const safe = error instanceof RelayFailure && error.retrySafe;
        const progress = registry.mirrorProgress(id)!;
        if (guarded || safe && progress.attempts < 3) {
          registry.write((tx) =>
            tx.deferMirror(
              id,
              token,
              Date.now(),
              Date.now() + (guarded ? 10_000 : 1000 * 2 ** progress.attempts),
              guarded,
            )
          );
        } else {await this.#finish(
            d,
            token,
            safe ? "mirror_failed" : "mirror_uncertain",
          );}
      }
    } finally {
      live.delete(token);
    }
  }
  observe(input: unknown, output: unknown): Promise<void> {
    if (this.#closed || this.ports.signal.aborted) return Promise.resolve();
    const task = this.#observe(input, output).catch(() => {});
    this.#observations.add(task);
    void task.finally(() => this.#observations.delete(task));
    return task;
  }
  async #observe(input: unknown, output: unknown) {
    const call = object(input), result = object(output);
    if (
      result.isError || typeof call.sessionID !== "string" ||
      typeof call.callID !== "string"
    ) return;
    const aliases = [...this.ports.relays.keys()].filter((a) =>
      call.tool === `${sanitizedAlias(a)}_send_message`
    );
    if (aliases.length !== 1) return;
    const args = object(call.args);
    if (typeof args.text !== "string") return;
    const raw = result.structuredContent ??
      JSON.parse(
        z.array(z.object({ type: z.string(), text: z.string().optional() }))
          .parse(result.content).find((p) => p.type === "text")?.text ?? "null",
      );
    const sent = z.object({ chat_id: positiveID, message_id: positiveID })
      .parse(raw);
    if (args.chat_id !== undefined && args.chat_id !== sent.chat_id) return;
    // Alias names are connection edges, not room identity. A session may make
    // its deliberate self-send through another configured alias of this relay;
    // Subscribe refreshes that edge only AFTER this observation. Conversely the
    // same numeric chat on another identity cannot supply self-send evidence.
    const identity = object(
      await this.ports.relays.get(aliases[0])!.call(
        "status",
        {},
        this.ports.signal,
      ),
    ).address;
    const rows = await this.ports.opencode.messages(call.sessionID);
    this.ports.signal.throwIfAborted();
    const registry = this.ports.registry();
    const hash = await fingerprint(args.text);
    for (const d of registry.deliveries(call.sessionID)) {
      const s = this.#binding(d);
      if (
        !["admitted", "submitted", "submitting"].includes(d.state) || !s ||
        identity !== d.relay || d.chat_id !== sent.chat_id
      ) continue;
      const submission = registry.submissions(d.id).at(-1);
      if (!submission) continue;
      const wake = rows.find((r) => r.info.id === submission.message_id);
      const facts = wake?.parts.find((p) => p.id === submission.part_id)
        ?.metadata?.deltaChatWake;
      if (
        !facts || object(facts).deliveryId !== d.id ||
        object(facts).relay !== d.relay || object(facts).chatId !== d.chat_id
      ) continue;
      // The hook lacks messageID. Only the *running* native tool part of this
      // wake can bind it; call_fixture IDs are reused in later assistant rows.
      for (const row of wakeAssistants(rows, submission.message_id)) {
        for (const part of row.parts) {
          const outer: string = call.callID.replace(/\/[1-9][0-9]*$/, "");
          if (
            part.type !== "tool" || object(part.state).status !== "running" ||
            !(part.callID === call.callID && part.tool === call.tool ||
              outer !== call.callID && part.callID === outer &&
                part.tool === "execute")
          ) continue;
          registry.write((tx) =>
            tx.recordModelSend(d.id, {
              messageID: row.info.id,
              partID: part.id,
              callID: call.callID as string,
              coreID: sent.message_id,
              fingerprint: hash,
            })
          );
        }
      }
    }
  }
  async close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    await Promise.allSettled([...this.#jobs.values(), ...this.#observations]);
  }
}
