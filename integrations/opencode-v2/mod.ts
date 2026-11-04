// SPDX-License-Identifier: LGPL-3.0-only
import { configuration } from "../conversations/config.ts";
import { Coordinator, type Host } from "../conversations/coordinator.ts";
import { Store } from "../conversations/store.ts";
import { ModernRelay } from "../opencode/modern-relay.ts";
import { nativeID } from "../opencode/registry.ts";
import { openSqlite } from "../opencode/sqlite.ts";

// Public 2.2.5 promise-plugin surface. No dependency on core/private services.
interface Registration {
  dispose(): Promise<void>;
}
interface Info {
  id: string;
  parentID?: string;
  revert?: unknown;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { busy?: number; idle?: number; archived?: number };
}
interface Prompt {
  sessionID: string;
  messageID: string;
  metadata?: Record<string, unknown>;
}
interface ToolContext {
  sessionID: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
}
interface Tool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  options: { namespace: string; codemode: true; permission: string };
  execute(
    args: unknown,
    context: ToolContext,
  ): Promise<{ output: unknown; content: string }>;
}
export interface Context {
  app: { version: string };
  options: unknown;
  location: { directory: string };
  session: {
    get(
      input: { sessionID: string },
      options?: { signal: AbortSignal },
    ): Promise<Info>;
    prompt(
      input: {
        sessionID: string;
        id: string;
        text: string;
        metadata: Record<string, unknown>;
        delivery: "queue";
      },
      options?: { signal: AbortSignal },
    ): Promise<{ id: string }>;
    hook(name: "prompt", cb: (input: Prompt) => void): Promise<Registration>;
    hook(
      name: "experimental.idle",
      cb: (
        input: { sessionID: string; background: readonly unknown[] },
      ) => void,
    ): Promise<Registration>;
  };
  tool: {
    transform(
      cb: (tools: { add(tool: Tool): void }) => void,
    ): Promise<Registration>;
  };
}

export default {
  id: "delta-chat-mcp-conversations",
  async setup(ctx: Context) {
    if (ctx.app.version !== "2.2.5") {
      throw new Error(
        "Delta Chat v2 integration requires qualified OpenCode 2.2.5",
      );
    }
    const config = configuration(ctx.options);
    const db = await openSqlite(config.stateFile);
    const store = new Store(db, `opencode-v2:${ctx.location.directory}`);
    const registrations: Registration[] = [];
    const turns = new Map<string, string>();
    const relays = new Map(
      config.relays.map((c) => [c.alias, new ModernRelay(c)]),
    );
    let monitor: ReturnType<typeof setTimeout> | undefined;
    let monitorJob: Promise<void> | undefined;
    let coordinator: Coordinator;
    const host: Host = {
      inputID: () => nativeID("msg"),
      async ready(session, signal) {
        const info = await ctx.session.get({ sessionID: session }, { signal });
        return !info.parentID && !info.revert && !info.time.archived &&
          (info.time.busy === undefined ||
            info.time.idle !== undefined && info.time.idle >= info.time.busy);
      },
      async admit(delivery, text, signal) {
        const receipt = await ctx.session.prompt({
          sessionID: delivery.session!,
          id: delivery.input!,
          text,
          metadata: {
            deltachat: { delivery: delivery.id, nonce: delivery.nonce },
          },
          delivery: "queue",
        }, { signal });
        if (receipt.id !== delivery.input) {
          throw new Error("Native input receipt mismatch");
        }
        // The public admission receipt proves the ID; the native prompt hook
        // supplies the actual turn boundary, even when it ran before this return.
      },
      tool: (alias, name) => `tools[${JSON.stringify(alias)}].${name}`,
      turn: (session) => turns.get(session),
      notice: (message) => console.error(message),
    };
    const watch = () => {
      if (coordinator.lifetime.signal.aborted || monitorJob) return;
      monitorJob = (async () => {
        try {
          for (
            const row of store.deliveries().filter((r) =>
              r.state === "observed"
            )
          ) {
            const info = await ctx.session.get({ sessionID: row.session! }, {
              signal: coordinator.lifetime.signal,
            });
            if (
              info.time.idle === undefined || info.time.idle < row.updated ||
              info.time.busy !== undefined && info.time.idle < info.time.busy
            ) continue;
            // Terminal metadata only. No answer-body read or automatic send.
            coordinator.finished(
              row.session!,
              row.turn!,
              info.outcome === "failed"
                ? "failed"
                : info.outcome === "interrupted"
                ? "interrupted_unanswered"
                : "finished",
            );
          }
        } catch {
          if (!coordinator.lifetime.signal.aborted) {
            host.notice(
              "delta-chat-mcp: native status pending; claims retained.",
            );
          }
        } finally {
          monitorJob = undefined;
          if (
            !coordinator.lifetime.signal.aborted &&
            store.deliveries().some((r) => r.state === "observed")
          ) monitor = setTimeout(watch, 1000);
        }
      })();
    };
    try {
      store.acquire();
      coordinator = new Coordinator(store, relays, host);
      registrations.push(
        await ctx.session.hook("prompt", (event) => {
          turns.set(event.sessionID, event.messageID);
          const metadata = event.metadata?.deltachat as {
            delivery?: string;
            nonce?: string;
          } | undefined;
          const row = metadata?.delivery
            ? store.delivery(metadata.delivery)
            : undefined;
          coordinator.input(
            event.sessionID,
            event.messageID,
            row?.nonce === metadata?.nonce ? row?.id : undefined,
          );
          clearTimeout(monitor);
          monitor = setTimeout(watch, 1000);
        }),
      );
      registrations.push(
        await ctx.session.hook("experimental.idle", (event) => {
          const turn = turns.get(event.sessionID);
          if (turn) coordinator.finished(event.sessionID, turn);
          coordinator.kick();
        }),
      );
      const definitions = await coordinator.catalog();
      registrations.push(
        await ctx.tool.transform((tools) => {
          for (const tool of definitions) {
            tools.add({
              name: tool.name,
              description: tool.description,
              input: tool.inputSchema,
              output: { type: "object", additionalProperties: true },
              options: {
                namespace: tool.alias,
                codemode: true,
                permission: `${tool.alias}_${tool.name}`,
              },
              execute: async (args, context) => {
                const result = await coordinator.call(
                  tool.alias,
                  tool.name,
                  args,
                  context.sessionID,
                  // Code Mode children inherit their parent's message/call IDs.
                  // Each actual invocation owns a separately prepared send intent;
                  // parent identifiers are provenance, not idempotency keys.
                  `${context.messageID}:${context.id}:${crypto.randomUUID()}`,
                  context.signal,
                );
                return { output: result, content: JSON.stringify(result) };
              },
            });
          }
        }),
      );
      coordinator.start();
    } catch (error) {
      const hooks = await Promise.allSettled(
        registrations.reverse().map((r) => r.dispose()),
      );
      const connections = await Promise.allSettled(
        [...relays.values()].map((relay) => relay.close()),
      );
      if (![...hooks, ...connections].some((r) => r.status === "rejected")) {
        try {
          store.release();
        } catch { /* Never release another owner's state. */ }
      }
      db.close();
      throw error;
    }
    return async () => {
      coordinator.lifetime.abort();
      clearTimeout(monitor);
      const hooks = await Promise.allSettled(
        registrations.reverse().map((r) => r.dispose()),
      );
      await monitorJob;
      const failed = hooks.some((r) => r.status === "rejected");
      try {
        await coordinator.close(!failed);
      } finally {
        db.close();
      }
      if (failed) {
        throw new Error(
          "Native hook cleanup failed; channel ownership retained",
        );
      }
    };
  },
};
