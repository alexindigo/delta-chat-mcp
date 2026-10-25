// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { pathfinder } from "@pathfinder/pathfinder";
import { SpikeMcp } from "../../src/mcp/spike.ts";
import { authFixture } from "../auth_support.ts";
import { deadline, lanAddress } from "../support.ts";

Deno.test("revoked Bearer cannot reuse an actual initialized MCP SDK session", async () => {
  const f = await authFixture();
  const endpoint = new SpikeMcp();
  await f.auth.setup({
    type: "password",
    username: "operator",
    password: "fixture-password",
  });
  const key = await f.apiKeys.create("SDK fixture");
  const app = await pathfinder({
    roots: [new URL("../../src/http/routes/", import.meta.url)],
    app: { auth: f.auth, apiKeys: f.apiKeys, log: f.log, mcp: endpoint },
  });
  const observed: { id: string | null; status: number }[] = [];
  const http = Deno.serve(
    { hostname: lanAddress(), port: 0, onListen() {} },
    async (request) => {
      const response = await app(request);
      observed.push({
        id: request.headers.get("mcp-session-id"),
        status: response.status,
      });
      return response;
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${lanAddress()}:${http.addr.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${key.key}` } } },
  );
  const client = new Client({ name: "m1-auth-proof", version: "0.0.0" });
  try {
    await deadline(client.connect(transport));
    assert(transport.sessionId);
    assertEquals(
      (await deadline(client.listTools())).tools.map((tool) => tool.name),
      ["ping"],
    );
    const sessionId = transport.sessionId;
    f.apiKeys.delete(key.id);
    await assertRejects(() => deadline(client.listTools(), 5000));
    assert(
      observed.some((item) => item.id === sessionId && item.status === 401),
    );
  } finally {
    await client.close();
    await endpoint.close();
    await http.shutdown();
    f.close();
  }
});
