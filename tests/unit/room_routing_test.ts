// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { roomMessage, routingFixture } from "../room_routing_support.ts";
import { poll } from "../support.ts";
import { openStateDb } from "../../src/state/db.ts";
import { RoomRoutingStore } from "../../src/messaging/room-routing-store.ts";
import { RoomRouting } from "../../src/messaging/room-routing.ts";
import { ApiKeys } from "../../src/auth/api-keys.ts";
import { ChangeHub } from "../../src/events.ts";

Deno.test("server chooses latest subscribed interest; persists others; freezes claimed work and reassigns only ready work", async () => {
  const f = await routingFixture();
  try {
    await f.routing.subscribe(f.first.id, "one", 42);
    await f.routing.subscribe(f.second.id, "two", 42);
    f.routing.interest(f.first.id, "unsubscribed", 42);
    assertEquals(
      f.routing.subscriptions(f.first.id, "unsubscribed").subscriptions,
      [],
    );
    f.incoming(roomMessage(7), roomMessage(500)); // intentionally not numeric order
    await poll(() => f.routing.inbox(f.second.id).deliveries.length === 1);
    const delivery = f.routing.inbox(f.second.id).deliveries[0];
    assertEquals(delivery.message_ids, [7, 500]);
    f.routing.interest(f.first.id, "one", 42);
    assertEquals(
      f.routing.inbox(f.first.id).deliveries[0].target_session,
      "one",
    );
    const claimant = crypto.randomUUID();
    const claim = f.routing.claim(f.first.id, delivery.delivery_id, claimant);
    assertEquals(
      f.routing.claim(f.first.id, delivery.delivery_id, claimant),
      claim,
    );
    assertThrows(() =>
      f.routing.claim(f.first.id, delivery.delivery_id, crypto.randomUUID())
    );
    assertThrows(() =>
      f.routing.claim(f.second.id, delivery.delivery_id, claimant)
    );
    f.routing.interest(f.second.id, "two", 42);
    f.incoming(roomMessage(3));
    await poll(() => f.routing.inbox(f.second.id).deliveries.length === 1);
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].message_ids, [
      7,
      500,
    ]);
    assertEquals(f.routing.inbox(f.second.id).deliveries[0].message_ids, [3]);
    f.routing.leave(f.second.id, "two", 42);
    assertEquals(
      f.routing.subscriptions(f.first.id, "one").subscriptions[0].recipient,
      true,
    );
    assertEquals(
      f.routing.subscriptions(f.second.id, "two").subscriptions[0].subscribed,
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test("integration body/claim/mirror/completion never changes interest; uncertain core post is never repeated", async () => {
  const f = await routingFixture();
  try {
    await f.routing.subscribe(f.first.id, "one", 42);
    f.incoming(
      roomMessage(2, { text: "full body\n".repeat(12000) }),
      roomMessage(4, { fromSelf: true }),
      roomMessage(6, { fromContactId: 2 }),
      roomMessage(8, { isInfo: true }),
      roomMessage(10, { isBot: true }),
    );
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    const d = f.routing.inbox(f.first.id).deliveries[0];
    assertEquals(d.message_ids, [2]);
    const c = f.routing.claim(f.first.id, d.delivery_id, crypto.randomUUID());
    await f.routing.subscribe(f.second.id, "two", 42);
    await poll(() =>
      f.routing.store.read().notices.every((n) => n.state !== "attempting")
    );
    const sequence = f.routing.store.read().sequence;
    const bodies = await f.routing.bodies(
      f.first.id,
      d.delivery_id,
      c.claim_token!,
    );
    assertEquals(bodies.messages[0].text, "full body\n".repeat(12000));
    assertEquals(f.seen, [2]);
    f.failSend();
    const before = f.sent.length;
    const mirrored = await f.routing.mirror(
      f.first.id,
      d.delivery_id,
      c.claim_token!,
      "final body",
    );
    assertEquals(mirrored.mirror, "uncertain");
    await f.routing.mirror(
      f.first.id,
      d.delivery_id,
      c.claim_token!,
      "must not resend",
    );
    assertEquals(f.sent.length, before + 1);
    f.routing.complete(
      f.first.id,
      d.delivery_id,
      c.claim_token!,
      "mirror_uncertain",
    );
    f.routing.complete(
      f.first.id,
      d.delivery_id,
      c.claim_token!,
      "mirror_uncertain",
    );
    assertEquals(f.routing.store.read().sequence, sequence);
    assertEquals(
      f.routing.subscriptions(f.second.id, "two").subscriptions[0].recipient,
      true,
    );
    const metadata = JSON.stringify(f.routing.store.read());
    assert(!metadata.includes("full body"));
    assert(!metadata.includes("final body"));
  } finally {
    await f.close();
  }
});

Deno.test("core-order survivor ring recovers a lost anchor; total ring loss blocks until explicit validated resume", async () => {
  const f = await routingFixture();
  try {
    await f.routing.subscribe(f.first.id, "one", 42);
    f.incoming(roomMessage(5), roomMessage(1));
    await poll(() => f.routing.store.read().rooms[0].anchor_id === 1);
    f.history.splice(f.history.findIndex((m) => m.id === 1), 1);
    f.incoming(roomMessage(3));
    await poll(() => f.routing.store.read().rooms[0].anchor_id === 3);
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].message_ids, [
      5,
      1,
      3,
    ]);
    f.history.splice(0, f.history.length, roomMessage(77));
    f.events.emit({ type: "connectivity" });
    await poll(() =>
      f.routing.store.read().rooms[0].state === "blocked_discontinuity"
    );
    const pending = f.routing.inbox(f.first.id).deliveries.find((d) =>
      d.state === "ready"
    )!;
    assertThrows(() =>
      f.routing.claim(f.first.id, pending.delivery_id, crypto.randomUUID())
    );
    const lostAnchor = f.routing.store.read().rooms[0].anchor_id;
    f.history.push(roomMessage(50, { fromSelf: true }));
    await f.routing.subscribe(f.first.id, "one", 42, 50);
    assertEquals(
      f.routing.store.read().rooms[0].state,
      "blocked_discontinuity",
    );
    assertEquals(f.routing.store.read().rooms[0].anchor_id, lostAnchor);
    await assertRejects(() => f.routing.resume(f.first.id, "one", 42, 999));
    await f.routing.resume(f.first.id, "one", 42, 77);
    f.incoming(roomMessage(2));
    await poll(() => f.routing.store.read().rooms[0].anchor_id === 2);
    assertEquals(f.routing.store.read().rooms[0].state, "active");
  } finally {
    await f.close();
  }
});

Deno.test("recipient notices occur only on changes; release and competing claims preserve the ownership boundary", async () => {
  const f = await routingFixture();
  try {
    await f.routing.subscribe(f.first.id, "one", 42);
    await poll(() =>
      f.routing.store.read().notices.every((n) => n.state !== "attempting")
    );
    f.routing.interest(f.first.id, "one", 42);
    f.routing.interest(f.first.id, "one", 42);
    assertEquals(f.routing.store.read().notices.length, 1);
    f.incoming(roomMessage(8));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    const d = f.routing.inbox(f.first.id).deliveries[0];
    const [a, b] = await Promise.allSettled([
      Promise.resolve().then(() =>
        f.routing.claim(f.first.id, d.delivery_id, crypto.randomUUID())
      ),
      Promise.resolve().then(() =>
        f.routing.claim(f.first.id, d.delivery_id, crypto.randomUUID())
      ),
    ]);
    assertEquals([a, b].filter((r) => r.status === "fulfilled").length, 1);
    const c = a.status === "fulfilled"
      ? a.value
      : b.status === "fulfilled"
      ? b.value
      : undefined;
    assert(c?.claim_token);
    await f.routing.subscribe(f.second.id, "two", 42);
    f.routing.release(f.first.id, d.delivery_id, c.claim_token);
    assertEquals(f.routing.inbox(f.second.id).deliveries[0].state, "ready");
    assertThrows(() =>
      f.routing.complete(f.first.id, d.delivery_id, c.claim_token!, "empty")
    );
  } finally {
    await f.close();
  }
});

Deno.test("restart preserves membership/claims/core-order metadata and exposes interrupted mirror/notice attempts without resending", async () => {
  const f = await routingFixture();
  await f.routing.subscribe(f.first.id, "native", 42);
  f.incoming(roomMessage(17));
  await poll(() =>
    f.routing.inbox(f.first.id).deliveries.length === 1 &&
    f.routing.store.read().notices.every((n) => n.state !== "attempting")
  );
  const d = f.routing.inbox(f.first.id).deliveries[0];
  const claim = f.routing.claim(f.first.id, d.delivery_id, crypto.randomUUID());
  await f.close();
  const db = openStateDb(f.access.dir),
    store = new RoomRoutingStore(db),
    keys = new ApiKeys(db);
  // Crash boundary: the durable attempt exists, no core acknowledgement does.
  store.write((s) => {
    s.deliveries[0].mirror = "attempting";
    s.notices[0].state = "attempting";
  });
  const count = f.sent.length;
  const restarted = new RoomRouting(store, {
    chats: f.chats,
    send: f.send,
    events: new ChangeHub(),
    authorized: (owner) => keys.has(owner),
  });
  try {
    const recovered = restarted.claim(
      f.first.id,
      d.delivery_id,
      claim.claimant!,
    );
    assertEquals(recovered.claim_token, claim.claim_token);
    assertEquals(recovered.mirror, "uncertain");
    assertEquals(
      restarted.subscriptions(f.first.id, "native").subscriptions[0].subscribed,
      true,
    );
    assertEquals(store.read().notices[0].state, "uncertain");
    await restarted.mirror(
      f.first.id,
      d.delivery_id,
      claim.claim_token!,
      "never replay",
    );
    assertEquals(f.sent.length, count);
  } finally {
    await restarted.close();
    db.close();
  }
});
