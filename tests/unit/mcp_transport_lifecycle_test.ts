// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { routingFixture } from "../room_routing_support.ts";
import { deadline, poll } from "../support.ts";

Deno.test("MCP facade legacy lifecycle metric tracks real SDK sessions independently of modern subscribers", async () => {
  const f = await routingFixture(), clients: Client[] = [];
  const legacy = async (key: string) => {
    const client = new Client({ name: "facade-legacy", version: "1" }, {
      versionNegotiation: { mode: "legacy" },
    });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL("http://relay.invalid/mcp"),
      {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
        fetch: f.fetcher,
      },
    );
    await deadline(client.connect(transport));
    assert(transport.sessionId);
    return { client, transport };
  };
  const modern = async (key: string) => {
    const client = new Client({ name: "facade-modern", version: "1" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    clients.push(client);
    await deadline(
      client.connect(
        new StreamableHTTPClientTransport(new URL("http://relay.invalid/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${key}` } },
          fetch: f.fetcher,
        }),
      ),
    );
    const uri =
      (await client.listResources()).resources.find((r) =>
        r.name === "room-inbox"
      )!.uri;
    return {
      client,
      uri,
      subscription: await client.listen({ resourceSubscriptions: [uri] }),
    };
  };
  try {
    const baseline = f.events.listenerCount;
    assertEquals(baseline, 1, "known service-owned routing listener");
    const unauthorized = await f.fetcher("http://relay.invalid/mcp", {
      method: "POST",
      body: "{}",
    });
    assertEquals(unauthorized.status, 401);
    await unauthorized.body?.cancel();
    assertEquals(f.transport.legacySessionCount, 0);
    const first = await legacy(f.first.key);
    assertEquals(f.transport.legacySessionCount, 1);
    const one = await modern(f.first.key);
    assertEquals(
      f.transport.legacySessionCount,
      1,
      "modern subscriber is not a legacy session",
    );
    await first.transport.terminateSession();
    await poll(() => f.transport.legacySessionCount === 0);
    await first.client.close();
    const resumed = await legacy(f.first.key),
      other = await legacy(f.second.key);
    assertEquals(f.transport.legacySessionCount, 2);
    const stolen = await f.fetcher("http://relay.invalid/mcp", {
      headers: {
        Authorization: `Bearer ${f.second.key}`,
        "mcp-session-id": resumed.transport.sessionId!,
      },
    });
    assertEquals(stolen.status, 404);
    await stolen.body?.cancel();
    const two = await modern(f.second.key);
    assertEquals(f.transport.legacySessionCount, 2);
    f.access.apiKeys.delete(f.first.id);
    await poll(() => f.transport.legacySessionCount === 1);
    assert(
      ["graceful", "remote"].includes(await deadline(one.subscription.closed)),
    );
    assert(
      (await two.client.readResource({ uri: two.uri })).contents.length > 0,
    );
    const revoked = await f.fetcher("http://relay.invalid/mcp", {
      headers: {
        Authorization: `Bearer ${f.first.key}`,
        "mcp-session-id": resumed.transport.sessionId!,
      },
    });
    assertEquals(revoked.status, 401);
    await revoked.body?.cancel();
    assertEquals(f.transport.legacySessionCount, 1);
    assert(other.transport.sessionId);
    await f.transport.close();
    assertEquals(f.transport.legacySessionCount, 0);
    assert(
      ["graceful", "remote"].includes(await deadline(two.subscription.closed)),
    );
    assertEquals(
      f.events.listenerCount,
      baseline,
      "closing MCP leaves only the routing owner",
    );
  } finally {
    const results = await Promise.allSettled(clients.map((c) => c.close()));
    await f.close();
    assertEquals(f.events.listenerCount, 0);
    assertEquals(f.transport.legacySessionCount, 0);
    assertEquals(results.every((r) => r.status === "fulfilled"), true);
  }
});
