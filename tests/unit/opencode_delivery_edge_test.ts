// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Inbox } from "../../integrations/opencode/inbox.ts";
import { ModernRelay } from "../../integrations/opencode/modern-relay.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { roomMessage, routingFixture } from "../room_routing_support.ts";
import { fixture, poll } from "../support.ts";

async function world() {
  const f = await routingFixture(),
    root = await fixture("delivery-edge"),
    registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const calls: {
    alias: string;
    method?: string;
    tool?: string;
    uri?: string;
  }[] = [];
  let wrongIdentity = false, changedNamespace = false;
  const edge = (alias: string, key: string) =>
    new ModernRelay({
      alias,
      url: `http://${alias}.invalid/mcp`,
      headers: { Authorization: `Bearer ${key}` },
      enabled: true,
    }, async (input, init) => {
      const request = new Request(input, init),
        body = request.method === "POST"
          ? await request.clone().json().catch(() => undefined)
          : undefined;
      calls.push({
        alias,
        method: body?.method,
        tool: body?.params?.name,
        uri: body?.params?.uri,
      });
      const actual = new Request(request);
      if (alias === "b" && changedNamespace) {
        actual.headers.set("Authorization", `Bearer ${f.second.key}`);
      }
      const response = await f.fetcher(actual);
      if (alias === "b" && wrongIdentity && body?.params?.name === "status") {
        const json = await response.json();
        json.result.structuredContent.address = "another@example.invalid";
        json.result.content[0].text = JSON.stringify(
          json.result.structuredContent,
        );
        return Response.json(json, {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    });
  const a = edge("a", f.first.key),
    b = edge("b", f.first.key),
    foreign = edge("foreign", f.second.key),
    lifetime = new AbortController();
  const inbox = new Inbox({
    registry: () => registry,
    relays: new Map([["a", a], ["b", b], ["foreign", foreign]]),
    owner: "http://local.invalid/",
    directory: "/A",
    signal: lifetime.signal,
    opencode: {
      session: () => Promise.resolve({ id: "native" }),
      status: () => Promise.resolve({}),
    },
    changed() {},
    notify: () => Promise.resolve(),
  });
  for (const alias of ["a", "b", "foreign"]) {
    registry.bindRemote(
      "native",
      alias,
      "relay@example.invalid",
      "http://local.invalid/",
      "/A",
      await ({ a, b, foreign })[alias as "a" | "b" | "foreign"].scope(),
    );
  }
  const integration = () =>
    calls.filter((c) =>
      ["inbox_claim", "inbox_mirror", "inbox_complete"].includes(
        c.tool ?? "",
      ) || c.uri?.includes("/delivery/")
    );
  return {
    f,
    registry,
    a,
    b,
    foreign,
    inbox,
    calls,
    integration,
    wrongIdentity: (v: boolean) => wrongIdentity = v,
    changedNamespace: (v: boolean) => changedNamespace = v,
    async claim() {
      await f.routing.subscribe(f.first.id, "native", 42);
      f.incoming(roomMessage(17));
      await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
      await inbox.sync("a");
      return registry.deliveries()[0];
    },
    async close() {
      lifetime.abort();
      await inbox.close();
      await Promise.all([a.close(), b.close(), foreign.close()]);
      registry.close();
      await f.close();
    },
  };
}
Deno.test("claimed delivery keeps its original authenticated edge across later alias bindings and same-scope failover", async () => {
  const w = await world();
  try {
    const d = await w.claim(), s = w.registry.subscriptions("native")[0];
    const beforePosts = w.f.sent.map((row) => ({ ...row }));
    w.registry.bindRemote(
      "native",
      "a",
      "another@example.invalid",
      "http://local.invalid/",
      "/A",
    );
    w.registry.write((tx) => tx.putSubscription({ ...s, alias: "foreign" }));
    assertEquals((await w.inbox.bodies(d))?.map((m) => m.id), [17]);
    w.a.config.enabled = false;
    const afterPause = w.calls.length;
    assertEquals((await w.inbox.bodies(d))?.map((m) => m.id), [17]);
    const sent = await w.inbox.mirror(d, "scoped final");
    assertEquals(sent.chat_id, 42);
    assertEquals(w.f.sent, [...beforePosts, {
      chat: 42,
      text: "scoped final",
    }]);
    w.registry.write((tx) =>
      tx.transition(d.id, "open", "cancelled", Date.now(), "left")
    );
    await w.inbox.sync("b");
    assertEquals(w.registry.remoteClaim(d.id)?.completed, true);
    assertEquals(
      w.f.routing.inbox(w.f.first.id).deliveries[0].state,
      "completed",
    );
    assertEquals(w.calls.slice(afterPause).filter((c) => c.alias === "a"), []);
    assertEquals(w.integration().filter((c) => c.alias === "foreign"), []);
    assert(
      w.integration().some((c) => c.alias === "b" && c.tool === "inbox_mirror"),
    );
  } finally {
    await w.close();
  }
});
Deno.test("delivery edges reject different namespaces and identities even on the same relay and room", async () => {
  const w = await world();
  try {
    const d = await w.claim();
    const beforePosts = w.f.sent.map((row) => ({ ...row }));
    w.a.config.enabled = false;
    w.b.config.enabled = false;
    const before = w.integration().length;
    await assertRejects(() => w.inbox.bodies(d));
    await assertRejects(() => w.inbox.mirror(d, "must not post"));
    assertEquals(w.integration().length, before);
    assertEquals(w.f.sent, beforePosts);
    const foreignScope = await w.foreign.scope();
    assertEquals(foreignScope.identity, d.relay);
    assert(foreignScope.uri !== w.registry.deliveryEdge(d.id)!.uri);
    w.b.config.enabled = true;
    w.foreign.config.enabled = false;
    w.wrongIdentity(true);
    assertEquals((await w.b.scope()).identity, "another@example.invalid");
    await assertRejects(() => w.inbox.bodies(d));
    assertEquals(w.integration().length, before);
  } finally {
    await w.close();
  }
});
Deno.test("the actual scoped operation revalidates authorization namespace after transport selection", async () => {
  const w = await world();
  try {
    const d = await w.claim();
    const beforePosts = w.f.sent.map((row) => ({ ...row }));
    w.a.config.enabled = false;
    w.foreign.config.enabled = false;
    const selected = await w.inbox.transport(d);
    assert(selected);
    w.changedNamespace(true);
    const before = w.integration().length;
    await assertRejects(() =>
      selected.relay.call("inbox_mirror", {
        delivery_id: d.id,
        claim_token: w.registry.remoteClaim(d.id)!.token,
        text: "must not post",
      })
    );
    assertEquals(w.integration().length, before);
    assertEquals(w.f.sent, beforePosts);
    w.changedNamespace(false);
    const enabled = await w.inbox.transport(d);
    assert(enabled);
    w.b.config.enabled = false;
    const requests = w.calls.length;
    await assertRejects(() =>
      enabled.relay.call("inbox_complete", {
        delivery_id: d.id,
        claim_token: w.registry.remoteClaim(d.id)!.token,
        outcome: "cancelled",
      })
    );
    assertEquals(w.calls.length, requests);
  } finally {
    await w.close();
  }
});
Deno.test("legacy claims with unknown scope never backfill transport authorization from a mutable alias", async () => {
  const w = await world();
  try {
    const id = crypto.randomUUID(),
      claimant = w.registry.prepareRemoteClaim(id);
    w.registry.importRemote({
      id,
      claimant,
      token: crypto.randomUUID(),
      session: "native",
      alias: "a",
      relay: "relay@example.invalid",
      chat: 42,
      anchor: 1,
      ids: [2],
      owner: "http://local.invalid/",
      directory: "/A",
    });
    const before = w.calls.length;
    await assertRejects(() => w.inbox.bodies(w.registry.deliveries()[0]));
    assertEquals(w.calls.length, before);
  } finally {
    await w.close();
  }
});
