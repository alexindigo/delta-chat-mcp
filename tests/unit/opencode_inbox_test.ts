// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Inbox } from "../../integrations/opencode/inbox.ts";
import { ModernRelay } from "../../integrations/opencode/modern-relay.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { roomMessage, routingFixture } from "../room_routing_support.ts";
import { fixture, poll } from "../support.ts";

Deno.test("inbox defers busy claims, freezes one batch, retries its durable claimant after local import loss and retains stable native IDs", async () => {
  const f = await routingFixture(), root = await fixture("inbox-progress");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  const lifetime = new AbortController();
  let busy = true;
  const changed: string[] = [];
  const inbox = new Inbox({
    registry: () => registry,
    relays: new Map([["relay", relay]]),
    owner: "http://local.invalid/",
    directory: "/project",
    signal: lifetime.signal,
    opencode: {
      session: () => Promise.resolve({ id: "native" }),
      status: () =>
        Promise.resolve({
          native: { type: busy ? "busy" as const : "idle" as const },
        }),
    },
    changed(session) {
      changed.push(session);
    },
    notify: () => Promise.resolve(),
  });
  try {
    registry.bindRemote(
      "native",
      "relay",
      "relay@example.invalid",
      "http://local.invalid/",
      "/project",
      await relay.scope(),
    );
    await relay.rawCall("room_subscribe", { chat_id: 42 }, undefined, "native");
    f.incoming(roomMessage(11));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    await inbox.sync("relay");
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].state, "ready");
    assertEquals(registry.deliveries(), []);
    f.incoming(roomMessage(3));
    await poll(() =>
      f.routing.inbox(f.first.id).deliveries[0].message_ids.length === 2
    );
    busy = false;
    const importRemote = registry.importRemote.bind(registry);
    registry.importRemote = () => {
      throw new Error("Owned local commit failure before admission");
    };
    await assertRejects(() => inbox.sync("relay"));
    const remote = f.routing.inbox(f.first.id).deliveries[0];
    assertEquals(remote.state, "claimed");
    const claimant = registry.remoteClaim(remote.delivery_id)!.claimant;
    assertEquals(remote.claimant, claimant);
    assertEquals(changed, []);
    registry.importRemote = importRemote;
    await inbox.sync("relay");
    const local = registry.deliveries()[0];
    assertEquals(local.id, remote.delivery_id);
    assertEquals(local.message_ids, [11, 3]);
    assertEquals(registry.remoteClaim(local.id)!.claimant, claimant);
    const native = registry.write((tx) =>
      tx.allocateSubmission(local.id, crypto.randomUUID(), 0, Date.now())
    );
    await inbox.sync("relay");
    assertEquals(registry.submissions(local.id)[0], native);
    assertEquals(registry.deliveries().length, 1);
    assert(changed.every((s) => s === "native"));
    const bodies = await inbox.bodies(local);
    assertEquals(bodies?.map((m) => m.id), [11, 3]);
    assert(!JSON.stringify(registry.remoteBindings()).includes(f.first.key));
  } finally {
    lifetime.abort();
    await inbox.close();
    await relay.close();
    registry.close();
    await f.close();
  }
});

Deno.test("inbox never claims a target without this directory's binding", async () => {
  const f = await routingFixture(), root = await fixture("inbox-unbound");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  const inbox = new Inbox({
    registry: () => registry,
    relays: new Map([["relay", relay]]),
    owner: "http://local.invalid/",
    directory: "/project",
    signal: new AbortController().signal,
    opencode: {
      session: () => {
        throw new Error("Unbound target must never query native state");
      },
      status: () => {
        throw new Error("Unbound target must never query native state");
      },
    },
    changed() {
      throw new Error("Unbound target admitted");
    },
    notify: () => Promise.resolve(),
  });
  try {
    await f.routing.subscribe(f.first.id, "another-instance", 42);
    f.incoming(roomMessage(2));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    await inbox.sync("relay");
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].state, "ready");
    assertEquals(registry.deliveries(), []);
  } finally {
    await inbox.close();
    await relay.close();
    registry.close();
    await f.close();
  }
});

Deno.test("an unsubmitted room does not reserve another room's native admission slot", async () => {
  const f = await routingFixture(),
    root = await fixture("inbox-room-isolation");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  const inbox = new Inbox({
    registry: () => registry,
    relays: new Map([["relay", relay]]),
    owner: "http://local.invalid/",
    directory: "/project",
    signal: new AbortController().signal,
    opencode: {
      session: () => Promise.resolve({ id: "native" }),
      status: () => Promise.resolve({ native: { type: "idle" as const } }),
    },
    changed() {},
    notify: () => Promise.resolve(),
  });
  try {
    registry.bindRemote(
      "native",
      "relay",
      "relay@example.invalid",
      "http://local.invalid/",
      "/project",
      await relay.scope(),
    );
    const earlier = crypto.randomUUID();
    const claimant = registry.prepareRemoteClaim(earlier);
    // Model the ledger after another room's body/edge preparation was deferred:
    // there is a frozen local batch but no native identity/submission at all.
    registry.importRemote({
      id: earlier,
      session: "native",
      alias: "relay",
      relay: "relay@example.invalid",
      chat: 99,
      anchor: 777,
      ids: [778],
      token: crypto.randomUUID(),
      claimant,
      owner: "http://local.invalid/",
      directory: "/project",
    });
    await f.routing.subscribe(f.first.id, "native", 42);
    f.incoming(roomMessage(17));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    await inbox.sync("relay");
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].state, "claimed");
    assertEquals(registry.deliveries().map((d) => d.chat_id).sort(), [42, 99]);
    assertEquals(registry.submissions(earlier), []);
  } finally {
    await inbox.close();
    await relay.close();
    registry.close();
    await f.close();
  }
});
