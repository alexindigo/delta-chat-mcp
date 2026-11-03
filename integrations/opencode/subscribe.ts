// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { sanitizedAlias } from "./options.ts";
import type { Registry } from "./registry.ts";
import type { RelayHealth } from "./relay.ts";
import { object, positiveID, type Subscription } from "./types.ts";

export interface SubscriptionRelay {
  identity(signal?: AbortSignal): Promise<string>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  readonly health: RelayHealth;
  refreshNativeState?(): Promise<boolean>;
}
export interface SubscribePorts {
  registry(): Registry;
  directory: string;
  owner: string;
  aliases: readonly string[];
  relays: ReadonlyMap<string, SubscriptionRelay>;
  unroutable: ReadonlySet<string>;
  signal: AbortSignal;
  toast(message: string): Promise<void>;
  // Later lifecycle owners reconcile committed changes; no watcher starts here.
  changed?(row: Subscription): void;
}
const target = z.object({ server: z.string().min(1), chat_id: positiveID })
  .strict();
const contextSchema = z.object({ sessionID: z.string().min(1) });
const sendResult = z.object({ message_id: positiveID, chat_id: positiveID });
const safeAlias = (alias: string) => JSON.stringify(sanitizedAlias(alias));
const notRecordedNotice =
  "delta-chat-mcp: room subscription NOT recorded (subscription storage or relay unavailable); replies in this room will not wake this session.";

/** Owns session-scoped subscriptions only. No prompts, watcher or relay sends. */
export class Subscribe {
  #tasks = new Set<Promise<unknown>>();
  #closed = false;
  #childNotices = new Map<string, string[]>();
  constructor(private readonly ports: SubscribePorts) {}

  #run<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed || this.ports.signal.aborted) {
      return Promise.reject(new Error("Integration stopped"));
    }
    const task = run();
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => {});
    return task;
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#tasks]);
    this.#childNotices.clear();
  }
  #relay(alias: string) {
    const canonical = this.#alias(alias);
    const relay = this.ports.relays.get(canonical);
    if (!relay || this.ports.unroutable.has(canonical)) {
      throw new Error("Relay unavailable");
    }
    return relay;
  }
  #alias(alias: string): string {
    if (this.ports.aliases.includes(alias)) return alias;
    const matches = this.ports.aliases.filter((a) =>
      sanitizedAlias(a) === alias
    );
    if (matches.length !== 1) throw new Error("Alias unavailable");
    return matches[0];
  }
  #changed(row: Subscription) {
    // A downstream observer cannot undo an already committed send/leave.
    try {
      this.ports.changed?.(row);
    } catch { /* consumer owns its health */ }
  }
  after(input: unknown, output: unknown): Promise<void> {
    // Never let observation turn an accepted remote send into an error/retry.
    return this.#run(async () => {
      let alias: string | undefined;
      let result: Record<string, unknown> | undefined;
      try {
        const call = object(input);
        if (call.tool === "execute") {
          const key = JSON.stringify([call.sessionID, call.callID]);
          const notices = this.#childNotices.get(key);
          this.#childNotices.delete(key);
          const result = object(output);
          if (notices && typeof result.output === "string") {
            result.output += `\n\n${notices.join("\n\n")}`;
          }
          return;
        }
        alias = this.ports.aliases.find((a) =>
          call.tool === `${sanitizedAlias(a)}_send_message`
        );
        if (!alias) return;
        const matchedAlias = alias;
        result = object(output);
        if (result.isError) return;
        const session = contextSchema.parse(call).sessionID;
        const raw = result.structuredContent ??
          JSON.parse(
            z.array(z.object({ type: z.string(), text: z.string().optional() }))
              .parse(result.content).find((c) => c.type === "text")?.text ??
              "null",
          );
        const sent = sendResult.parse(raw);
        const relay = await this.#relay(alias).identity(this.ports.signal);
        this.ports.signal.throwIfAborted();
        const row = this.ports.registry().write((tx) =>
          tx.subscribe({
            session_id: session,
            relay,
            ...sent,
            alias: matchedAlias,
            directory: this.ports.directory,
            owner_server: this.ports.owner,
          }, Date.now())
        );
        this.#changed(row);
        this.#notice(
          call,
          result,
          row.state === "blocked_discontinuity"
            ? `delta-chat-mcp: this session remains subscribed to room ${sent.chat_id} on ${
              safeAlias(alias)
            }, but is blocked_discontinuity; explicit delta_chat_room_resume is required.`
            : `delta-chat-mcp: this session is subscribed to room ${sent.chat_id} on ${
              safeAlias(alias)
            }; new human messages will wake it. Leave with delta_chat_room_leave {server:${
              safeAlias(alias)
            }, chat_id:${sent.chat_id}}.`,
        );
      } catch {
        if (!alias || !result) return;
        this.#notice(object(input), result, notRecordedNotice);
        try {
          await this.ports.toast(notRecordedNotice);
        } catch { /* best effort after bootstrap */ }
      }
    }).catch(() => {
      // Disposal can win before observation starts. Preserve the successful
      // remote result and report non-recording even when storage is already closed.
      try {
        const call = object(input), result = object(output);
        if (
          !result.isError &&
          this.ports.aliases.some((alias) =>
            call.tool === `${sanitizedAlias(alias)}_send_message`
          )
        ) this.#notice(call, result, notRecordedNotice);
      } catch { /* Observation must never throw into an accepted send. */ }
    });
  }
  #append(result: Record<string, unknown>, text: string) {
    if (Array.isArray(result.content)) {
      result.content.push({ type: "text", text });
    }
  }
  #notice(
    call: Record<string, unknown>,
    result: Record<string, unknown>,
    text: string,
  ) {
    this.#append(result, text);
    // Pinned code-mode.ts:109 discards content when structuredContent exists.
    // Its :227 child ID is `${parentCallID}/${ordinal}`. Carry only our notice
    // to the matching outer after-hook (:300–305), keeping the remote payload
    // intact and never treating an execute call itself as a subscription trigger.
    if (
      typeof call.sessionID !== "string" || typeof call.callID !== "string"
    ) return;
    const child = /^(.*)\/[1-9][0-9]*$/.exec(call.callID);
    if (!child) return;
    const key = JSON.stringify([call.sessionID, child[1]]);
    this.#childNotices.set(key, [...(this.#childNotices.get(key) ?? []), text]);
  }
  tools() {
    const wrap =
      (run: (args: unknown, session: string) => Promise<unknown>) =>
      async (args: unknown, context: unknown) => {
        try {
          return await this.#run(async () =>
            JSON.stringify(
              await run(args, contextSchema.parse(context).sessionID),
            )
          );
        } catch {
          // Never serialize raw SQLite, SDK, URL/header or validation errors.
          return JSON.stringify({
            error:
              "Subscription operation unavailable or invalid; inspect this session's subscriptions.",
          });
        }
      };
    const args = {
      server: { type: "string" },
      chat_id: { type: "integer", minimum: 1 },
    };
    const key = async (args: unknown, session: string) => {
      const parsed = target.parse(args);
      const relay = await this.#relay(parsed.server).identity(
        this.ports.signal,
      );
      return { session_id: session, relay, chat_id: parsed.chat_id };
    };
    return {
      delta_chat_room_leave: {
        description:
          "Durably leave this session's room subscription. Does not leave or delete the shared Delta Chat group, identity or history. Admitted work still completes.",
        args,
        execute: wrap(async (args, session) => {
          const parsed = target.parse(args);
          // Stored alias is sufficient for durable leave while offline/disabled.
          const matches = this.ports.registry().subscriptions(session).filter((
            r,
          ) =>
            (r.alias === parsed.server ||
              sanitizedAlias(r.alias) === parsed.server) &&
            r.chat_id === parsed.chat_id
          );
          const routing = matches.length === 1
            ? matches[0]
            : await key(args, session);
          const row = this.ports.registry().write((tx) =>
            tx.leave(routing, Date.now())
          );
          this.#changed(row);
          return {
            server: parsed.server,
            chat_id: row.chat_id,
            state: row.state,
          };
        }),
      },
      delta_chat_room_subscriptions: {
        description:
          "List only this session's durable room subscriptions, routing health and delivery states; no credentials or message text.",
        args: {},
        execute: wrap(async (args, session) => {
          z.object({}).strict().parse(args);
          await Promise.allSettled(
            [...this.ports.relays.values()].map((relay) =>
              relay.refreshNativeState?.()
            ),
          );
          const registry = this.ports.registry();
          const deliveries = registry.deliveries(session);
          return {
            subscriptions: registry.subscriptions(session).map((r) => ({
              server: sanitizedAlias(r.alias),
              relay: r.relay,
              chat_id: r.chat_id,
              state: this.ports.unroutable.has(r.alias) ||
                  !this.ports.relays.has(r.alias)
                ? "unroutable"
                : r.state,
              subscription_state: r.state,
              anchor_id: r.anchor_id,
              health: this.ports.relays.get(r.alias)?.health ??
                { state: "unroutable" },
              deliveries: deliveries.filter((d) =>
                d.relay === r.relay && d.chat_id === r.chat_id
              ).map((d) => ({
                id: d.id,
                state: d.state,
                user_message_id: d.user_message_id,
                superseding_message_id: d.superseding_message_id,
              })),
            })),
            aliases: this.ports.aliases.map((alias) => ({
              server: sanitizedAlias(alias),
              health: this.ports.relays.get(alias)?.health ??
                { state: "unroutable" },
            })),
          };
        }),
      },
      delta_chat_room_resume: {
        description:
          "Explicitly resume this session's blocked_discontinuity subscription after an operator-chosen existing core message in this chat. Earlier messages are not replayed.",
        args: { ...args, after_id: { type: "integer", minimum: 1 } },
        execute: wrap(async (args, session) => {
          const parsed = target.extend({ after_id: positiveID }).parse(args);
          const routing = await key({
            server: parsed.server,
            chat_id: parsed.chat_id,
          }, session);
          const prior = this.ports.registry().subscriptions(session).find((r) =>
            r.relay === routing.relay && r.chat_id === routing.chat_id
          );
          if (prior?.state !== "blocked_discontinuity") {
            throw new Error("Not blocked");
          }
          // The existing read contract rejects an absent/deleted/wrong-chat anchor,
          // including when the page after a valid final message is empty.
          await this.#relay(parsed.server).call("read_messages", {
            chat_id: parsed.chat_id,
            after_id: parsed.after_id,
            limit: 1,
          }, this.ports.signal);
          this.ports.signal.throwIfAborted();
          const row = this.ports.registry().write((tx) =>
            tx.resume(routing, parsed.after_id, Date.now())
          );
          this.#changed(row);
          return {
            server: parsed.server,
            chat_id: row.chat_id,
            state: row.state,
            anchor_id: row.anchor_id,
          };
        }),
      },
    };
  }
}
