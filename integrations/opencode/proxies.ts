// SPDX-License-Identifier: LGPL-3.0-only
import { sanitizedAlias } from "./options.ts";
import type { ModernRelay } from "./modern-relay.ts";
import type { Registry } from "./registry.ts";
import { object } from "./types.ts";
import { z } from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(id).max(100);
const text = z.string().min(1);
// Native v1's raw-JSON compatibility path marks every property required.
// Its public Zod-argument path preserves optional pagination/destinations.
export const publicTools: Record<string, {
  description: string;
  args: Record<string, z.ZodType>;
}> = {
  status: { description: "Relay identity and connectivity.", args: {} },
  list_contacts: {
    description: "Contacts and current encryption availability.",
    args: {},
  },
  list_chats: { description: "All canonical chats and rooms.", args: {} },
  read_messages: {
    description:
      "Read history with returned-incoming-only receipts; after_id OR before_id. Expresses interest only if already subscribed.",
    args: {
      chat_id: id,
      after_id: id.optional(),
      before_id: id.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  send_message: {
    description:
      "Send exact text to chat_id OR contact_id. Successful room send subscribes/rejoins this native session. An uncertain result may already have posted: inspect the room before deliberately retrying.",
    args: { chat_id: id.optional(), contact_id: id.optional(), text },
  },
  message_status: {
    description: "Batch core delivery/read/not-found facts.",
    args: { message_ids: ids },
  },
  delete_messages: {
    description: "Explicitly delete only this relay identity's local copies.",
    args: { message_ids: ids },
  },
  create_room: {
    description:
      "Create an encrypted room. First send delivers invitation; resume_chat_id completes an incomplete room, never blindly recreate.",
    args: {
      name: text,
      contact_ids: ids,
      resume_chat_id: id.max(0xffffffff).optional(),
    },
  },
  room_subscribe: {
    description:
      "Subscribe/rejoin this native session and become the latest room recipient.",
    args: { chat_id: id },
  },
  room_subscriptions: {
    description:
      "Inspect server-owned persistent room subscriptions, recipient and discontinuity.",
    args: {},
  },
  room_leave: {
    description:
      "Leave this session's subscription, retaining shared history and claimed work.",
    args: { chat_id: id },
  },
  room_resume: {
    description:
      "Explicitly resume a blocked room after an operator-chosen existing core message.",
    args: { chat_id: id, after_id: id },
  },
};
export interface ProxyPorts {
  aliases: readonly string[];
  relays: ReadonlyMap<string, ModernRelay>;
  registry(): Registry;
  owner: string;
  directory: string;
  signal: AbortSignal;
  changed(): void;
  prepareSend?(
    alias: string,
    scope: import("./types.ts").RelayScope,
    args: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<string[]>;
  settleSend?(attempts: string[], result?: unknown, error?: unknown): void;
  notify?(message: string): Promise<void>;
}
/** v1 plugin tools are direct. Serialize the entire MCP result unchanged into
 * the native string result, retaining isError/content/structuredContent. */
export class Proxies {
  #tasks = new Set<Promise<unknown>>();
  #closed = false;
  #lifetime = new AbortController();
  constructor(private readonly ports: ProxyPorts) {}
  tools() {
    return Object.fromEntries(
      this.ports.aliases.flatMap((alias) =>
        Object.entries(publicTools).map((
          [name, definition],
        ) => [`${sanitizedAlias(alias)}_${name}`, {
          ...definition,
          execute: (args: unknown, context: unknown) => {
            const task = this.#execute(alias, name, args, context);
            this.#tasks.add(task);
            void task.finally(() => this.#tasks.delete(task)).catch(() => {});
            return task;
          },
        }])
      ),
    );
  }
  async #execute(alias: string, name: string, args: unknown, context: unknown) {
    if (this.#closed || this.ports.signal.aborted) {
      throw new Error("Integration stopped");
    }
    const ctx = object(context);
    if (typeof ctx.sessionID !== "string" || !ctx.sessionID) {
      throw new Error("Native session context required");
    }
    const ask = ctx.ask;
    if (typeof ask !== "function") {
      throw new Error("Native permission context required");
    }
    const signal = AbortSignal.any([
      this.ports.signal,
      this.#lifetime.signal,
      ...(ctx.abort instanceof AbortSignal ? [ctx.abort] : []),
    ]);
    signal.throwIfAborted();
    // V1 plugin tools do not inherit the native MCP wrapper's permission ask.
    // Use the supplied ToolContext API before binding or any relay I/O.
    const stopped = Promise.withResolvers<never>();
    const abort = () => stopped.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          Reflect.apply(ask, ctx, [{
            permission: `${sanitizedAlias(alias)}_${name}`,
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          }])
        ),
        stopped.promise,
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
    // The native permission object belongs to OpenCode. Cancelling our waiter
    // neither approves/rejects it nor permits dispatch after a late resolution.
    signal.throwIfAborted();
    const relay = this.ports.relays.get(alias);
    if (!relay) throw new Error("Relay unavailable");
    // Native binding exists before a successful send can trigger inbox updates.
    // This is admission ownership, not an instruction to subscribe on the relay.
    const scope = await relay.scope(signal);
    this.ports.registry().bindRemote(
      ctx.sessionID,
      alias,
      scope.identity,
      this.ports.owner,
      this.ports.directory,
      scope,
    );
    const supplied = object(args);
    // A model argument never overrides the host's native session identity.
    const clean = Object.fromEntries(
      Object.entries(supplied).filter(([k]) =>
        k !== "session_id" && k !== "_meta"
      ),
    );
    const attempts = name === "send_message"
      ? await this.ports.prepareSend?.(alias, scope, clean, ctx) ?? []
      : [];
    let result;
    try {
      signal.throwIfAborted();
      result = await relay.rawCall(name, clean, signal, ctx.sessionID, scope);
    } catch (error) {
      await this.#settle(attempts, undefined, error);
      throw error;
    }
    await this.#settle(attempts, result);
    this.ports.changed();
    return JSON.stringify(result);
  }
  async #settle(attempts: string[], result?: unknown, error?: unknown) {
    try {
      this.ports.settleSend?.(attempts, result, error);
    } catch {
      // The pending durable intent remains conservative. A failed local receipt
      // must never replace the actual accepted MCP envelope with a tool error.
      if (!this.ports.signal.aborted) {
        await this.ports.notify?.(
          "delta-chat-mcp: model send receipt unavailable; pending native intent retained. Inspect the room before any explicit resend.",
        ).catch(() => {});
      }
    }
  }
  async close() {
    this.#closed = true;
    this.#lifetime.abort();
    await Promise.allSettled([...this.#tasks]);
  }
}
