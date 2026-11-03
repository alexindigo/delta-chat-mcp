// SPDX-License-Identifier: LGPL-3.0-only
// A single-file test probe, not the room-wake product plugin.
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

const epoch = crypto.randomUUID();
interface Input {
  directory: string;
  serverUrl: URL;
  client: {
    session: {
      status(input?: unknown): Promise<{ data?: unknown; error?: unknown }>;
    };
    tui: { showToast(input: unknown): Promise<{ error?: unknown }> };
  };
}

export default async function probe(input: Input) {
  const write = (kind: string, facts: Record<string, unknown> = {}) => {
    appendFileSync(
      process.env.DCMCP_PROBE_LOG!,
      JSON.stringify({
        time: Date.now(),
        kind,
        directory: input.directory,
        epoch,
        ...facts,
      }) + "\n",
    );
  };
  let sqlite = "unavailable";
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("select 37 as n").get();
    if (row?.n === 37) sqlite = "node:sqlite";
    db.close();
  } catch {
    try {
      const specifier = "bun:sqlite";
      const { Database } = await import(specifier);
      const db = new Database(":memory:");
      if (db.query("select 37 as n").get()?.n === 37) sqlite = "bun:sqlite";
      db.close();
    } catch { /* The contract fails if neither implementation works. */ }
  }
  write("init", {
    serverUrl: String(input.serverUrl),
    tmpdir: tmpdir(),
    sqlite,
  });
  return {
    config(
      config: {
        mcp?: Record<
          string,
          { url?: string; headers?: Record<string, string> }
        >;
      },
    ) {
      const server = config.mcp?.fixture;
      write("config", {
        resolvedUrl: server?.url === process.env.DCMCP_TEST_MCP_URL,
        resolvedHeader: server?.headers?.Authorization ===
          `Bearer ${process.env.DCMCP_TEST_MCP_TOKEN}`,
      });
    },
    event(
      { event }: {
        event: { type: string; properties: Record<string, unknown> };
      },
    ) {
      write("event", { type: event.type, properties: event.properties });
    },
    "tool.execute.after"(
      call: Record<string, unknown>,
      output: Record<string, unknown>,
    ) {
      write("after", { call, output });
      const args = call.args as Record<string, unknown> | undefined;
      if (args?.mode === "throw") throw new Error("j0-after-hook-throw");
      if (Array.isArray(output.content)) {
        output.content.push({ type: "text", text: "J0_APPENDED_NOTICE" });
      }
    },
    tool: {
      j0_probe: {
        description: "J0 contract: JSON-schema tool with real session context",
        args: { action: { type: "string" }, directory: { type: "string" } },
        async execute(
          args: { action?: string; directory?: string },
          context: { sessionID: string },
        ) {
          if (args.action === "status") {
            const result = await input.client.session.status();
            write("client", {
              ok: result.error === undefined && result.data !== undefined,
            });
          }
          if (args.action === "cross") {
            const result = await input.client.session.status({
              query: { directory: args.directory },
            });
            write("cross", {
              ok: result.error === undefined,
              target: args.directory,
            });
          }
          if (args.action === "toast") {
            const result = await input.client.tui.showToast({
              body: { message: "J0 fixture", variant: "info" },
            });
            write("toast", { ok: result.error === undefined });
          }
          write("tool", { sessionID: context.sessionID, action: args.action });
          return JSON.stringify({ sessionID: context.sessionID, epoch });
        },
      },
    },
    dispose() {
      write("dispose");
    },
  };
}
