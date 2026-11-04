// SPDX-License-Identifier: LGPL-3.0-only
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { configuration } from "../conversations/config.ts";
import { Coordinator, type Host } from "../conversations/coordinator.ts";
import { Store } from "../conversations/store.ts";
import { ModernRelay } from "../opencode/modern-relay.ts";
import { openSqlite } from "../opencode/sqlite.ts";
import { nativeOwner, nativeSchema, NativeState } from "./native.ts";

const config = configuration(JSON.parse(readFileSync(Deno.args[0], "utf8")));
const db = await openSqlite(config.stateFile);
nativeSchema(db);
const owner = nativeOwner();
const binding = db.get(
  "SELECT session FROM channel_native WHERE owner=? AND ended=0",
  owner,
);
if (!binding) {
  db.close();
  throw new Error(
    "Delta Chat channel has no matching native SessionStart binding",
  );
}
const store = new Store(db, `claude:${binding.session}`);
const native = new NativeState(store, owner);
store.acquire();
const relays = new Map(config.relays.map((c) => [c.alias, new ModernRelay(c)]));
const server = new McpServer({ name: "delta-chat", version: "0.1.0" }, {
  supportedProtocolVersions: ["2025-11-25"],
  capabilities: { experimental: { "claude/channel": {} } },
  instructions:
    "Delta Chat messages arrive as channel events. The sender reads Delta Chat. Call the matching alias_send_message tool to send every reply they should see; ordinary terminal responses are not forwarded. Use read_messages for earlier chat context. Inspect chat history before retrying an unconfirmed send. Room subscriptions persist until an explicit room_leave.",
});
let initialized = false;
const host: Host = {
  inputID: () => crypto.randomUUID(),
  ready: (session) => Promise.resolve(initialized && native.ready(session)),
  admit: async (delivery, text, signal) => {
    signal.throwIfAborted();
    if (native.session() !== delivery.session) {
      throw new Error("Native channel session unavailable");
    }
    await server.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: {
          chat_id: String(delivery.chat),
          delivery_id: delivery.id,
          input_id: delivery.input!,
          nonce: delivery.nonce!,
        },
      },
    });
    // Only the later native hook/tool observations count as consumption.
  },
  tool: (alias, name) => `${alias}_${name}`,
  turn: (session, call) => native.turn(session, call),
  notice: (text) => console.error(text),
};
const coordinator = new Coordinator(store, relays, host);
let timer: ReturnType<typeof setInterval> | undefined;
let stopping: Promise<void> | undefined;
function stop() {
  if (stopping) return stopping;
  clearInterval(timer);
  stopping = (async () => {
    await coordinator.close();
    await server.close();
    db.close();
  })();
  return stopping;
}
try {
  for (const tool of await coordinator.catalog()) {
    const schema = z.fromJSONSchema(tool.inputSchema);
    server.registerTool(`${tool.alias}_${tool.name}`, {
      description: tool.description,
      inputSchema: schema,
    }, async (args, context) => {
      native.drain(coordinator);
      const session = native.session();
      const call = context.mcpReq._meta?.["claudecode/toolUseId"];
      if (!session || typeof call !== "string" || !native.turn(session, call)) {
        throw new Error("Native main-session tool context required");
      }
      return await coordinator.call(
        tool.alias,
        tool.name,
        args,
        session,
        call,
        context.mcpReq.signal,
      );
    });
  }
  const transport = new StdioServerTransport();
  server.server.onclose = () => {
    void stop().catch((error) => {
      console.error(error.message);
      Deno.exitCode = 1;
    });
  };
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    if (client?.name !== "claude-code" || client.version !== "2.1.316") {
      host.notice(
        "delta-chat-mcp: this channel requires qualified Claude Code 2.1.316",
      );
      void stop().catch(() => {
        Deno.exitCode = 1;
      });
      return;
    }
    initialized = true;
    native.drain(coordinator);
    coordinator.start();
  };
  await server.connect(transport);
  // Local metadata hints only: never model polling or remote wait_for_messages.
  timer = setInterval(() => {
    try {
      native.drain(coordinator);
    } catch {
      host.notice("delta-chat-mcp: native receipts pending; claims retained.");
    }
  }, 250);
  const stoppingSignal = () => {
    void stop().then(() => Deno.exit(0), () => Deno.exit(1));
  };
  Deno.addSignalListener("SIGTERM", stoppingSignal);
  Deno.addSignalListener("SIGINT", stoppingSignal);
} catch (error) {
  await stop();
  throw error;
}
