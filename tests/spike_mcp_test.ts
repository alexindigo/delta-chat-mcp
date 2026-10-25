// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { pathfinder } from "@pathfinder/pathfinder";
import { SpikeMcp } from "../src/mcp/spike.ts";
import { deadline, lanAddress, poll } from "./support.ts";
import { publicAuth } from "./auth_support.ts";

const roots = [new URL("../src/http/routes/", import.meta.url)];

Deno.test("MCP client handshakes, lists ping, calls pong and deletes its session over LAN HTTP", async () => {
  const endpoint = new SpikeMcp();
  const methods = new Set<string>();
  const nativeResponses: Response[] = [];
  const app = await pathfinder({
    roots,
    app: {
      auth: await publicAuth(),
      mcp: {
        async handleRequest(raw: Request) {
          methods.add(raw.method);
          const response = await endpoint.handleRequest(raw);
          nativeResponses.push(response);
          return response;
        },
      },
    },
  });
  const hostname = lanAddress();
  const http = Deno.serve({ hostname, port: 0, onListen() {} }, async (raw) => {
    const response = await app(raw);
    assert(
      nativeResponses.includes(response),
      "Pathfinder must preserve native Response identity",
    );
    return response;
  });
  // Chromium's resolver flags do not affect Deno. The client uses the actual
  // LAN IP, preserving non-loopback HTTP without changing shared DNS.
  const url = new URL(`http://${hostname}:${http.addr.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "m0-proof", version: "0.0.0" });
  try {
    await deadline(client.connect(transport));
    assert(transport.sessionId);
    assertEquals(endpoint.sessionCount, 1);
    const tools = await deadline(client.listTools());
    assertEquals(tools.tools.map((tool) => tool.name), ["ping"]);
    const result = await deadline(
      client.callTool({ name: "ping", arguments: {} }),
    );
    assertEquals(result.content, [{ type: "text", text: "pong" }]);
    assert(
      nativeResponses.some((response) =>
        response.headers.get("content-type")?.includes("text/event-stream")
      ),
    );
    await deadline(transport.terminateSession());
    await poll(() => endpoint.sessionCount === 0);
    assertEquals([...methods].sort(), ["DELETE", "GET", "POST"]);
    console.log(
      `${url}: handshake; tools=[ping]; pong; sessions=${endpoint.sessionCount}; native SSE Response`,
    );
  } finally {
    await client.close();
    await endpoint.close();
    await http.shutdown();
  }
});

Deno.test("MCP route passes the raw Request and streaming Response without wrapping", async () => {
  const raw = new Request("http://delta-chat-mcp.test/mcp", { method: "GET" });
  const native = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: pong\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const app = await pathfinder({
    roots,
    app: {
      auth: await publicAuth(),
      mcp: {
        handleRequest(request: Request) {
          assertStrictEquals(request, raw);
          return Promise.resolve(native);
        },
      },
    },
  });
  const response = await app(raw);
  assertStrictEquals(response, native);
  assertEquals(await response.text(), "data: pong\n\n");
});
