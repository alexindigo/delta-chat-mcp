// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpSessions } from "../../src/mcp/sessions.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { authFixture } from "../auth_support.ts";
import { deadline, lanAddress, poll } from "../support.ts";
import { pathfinder } from "@pathfinder/pathfinder";
import { z } from "zod";

Deno.test("product MCP binds sessions to keys, cancels live calls on revocation and expires idle sessions", async () => {
  const f = await authFixture();
  await f.auth.setup({
    type: "password",
    username: "operator",
    password: "fixture-password",
  });
  const first = await f.apiKeys.create("first"),
    other = await f.apiKeys.create("other");
  let waiting = false, cancelled = false;
  const endpoint = new McpSessions(f.apiKeys, (signal) => {
    const server = createMcpServer();
    server.registerTool("hold", { inputSchema: z.object({}) }, async () => {
      waiting = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => {
          cancelled = true;
          resolve();
        }, { once: true })
      );
      return { content: [] };
    });
    return server;
  }, 2000);
  const handler = await pathfinder({
    roots: [new URL("../../src/http/routes/", import.meta.url)],
    app: { auth: f.auth, apiKeys: f.apiKeys, mcp: endpoint },
  });
  const http = Deno.serve(
    { hostname: lanAddress(), port: 0, onListen() {} },
    handler,
  );
  const url = new URL(`http://${lanAddress()}:${http.addr.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${first.key}` } },
  });
  const client = new Client({ name: "m2-sessions", version: "0" });
  try {
    const noKey = await fetch(url, { method: "POST", body: "{}" });
    assertEquals(noKey.status, 401);
    await noKey.body?.cancel();
    assertEquals(endpoint.sessionCount, 0);
    await deadline(client.connect(transport));
    assertEquals(endpoint.sessionCount, 1);
    const stolen = await fetch(url, {
      headers: {
        Authorization: `Bearer ${other.key}`,
        "mcp-session-id": transport.sessionId!,
      },
    });
    assertEquals(stolen.status, 404);
    await stolen.body?.cancel();
    const held = assertRejects(() =>
      deadline(client.callTool({ name: "hold", arguments: {} }), 5000)
    );
    await poll(() => waiting);
    f.apiKeys.delete(first.id);
    await poll(() => cancelled && endpoint.sessionCount === 0);
    await held;
    const revoked = await fetch(url, {
      headers: {
        Authorization: `Bearer ${first.key}`,
        "mcp-session-id": transport.sessionId!,
      },
    });
    assertEquals(revoked.status, 401);
    assertEquals(revoked.headers.get("www-authenticate"), "Bearer");
    await revoked.body?.cancel();
    assertEquals(endpoint.sessionCount, 0);
    assert(cancelled);
    const expiring = new Client({ name: "idle", version: "0" });
    try {
      await expiring.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${other.key}` } },
        }),
      );
      assertEquals(endpoint.sessionCount, 1);
      await poll(() => endpoint.sessionCount === 0, 6000);
    } finally {
      await expiring.close();
    }
  } finally {
    await client.close();
    await endpoint.close();
    await http.shutdown();
    f.close();
  }
});
