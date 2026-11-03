// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { ModernRelay } from "../../integrations/opencode/modern-relay.ts";
import { roomMessage, routingFixture } from "../room_routing_support.ts";
import { poll } from "../support.ts";

// Subscription interval counterexamples: accepted-send boundaries, concurrent
// scan/leave/rejoin, preserved backlog and claimed-work ownership.
Deno.test("accepted send anchors at its returned core ID, including a peer reply before subscription bookkeeping", async () => {
  const f = await routingFixture();
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  const originalSend = f.send.sendText;
  f.send.sendText = (chat, text) => {
    if (text !== "first subscription send") return originalSend(chat, text);
    f.history.push(roomMessage(7, { fromSelf: true, text }), roomMessage(3));
    return Promise.resolve({
      messageId: 7,
      chatId: chat,
      state: "delivered" as const,
    });
  };
  try {
    const result = await relay.rawCall(
      "send_message",
      {
        chat_id: 42,
        text: "first subscription send",
      },
      undefined,
      "native",
    );
    assert(
      result.structuredContent &&
        typeof result.structuredContent === "object" &&
        "message_id" in result.structuredContent,
    );
    assertEquals(result.structuredContent.message_id, 7);
    await poll(() =>
      f.routing.inbox(f.first.id).deliveries.some((d) => d.state === "ready")
    );
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].message_ids, [3]);
  } finally {
    await relay.close();
    await f.close();
  }
});

Deno.test("a later subscribed send cannot move an active cursor over unscanned backlog", async () => {
  const f = await routingFixture();
  const read = f.chats.routingMessages;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let once = true;
  try {
    await f.routing.subscribe(f.first.id, "native", 42);
    f.chats.routingMessages = async (chat, after) => {
      if (once) {
        once = false;
        held.resolve();
        await release.promise;
      }
      return await read(chat, after);
    };
    f.incoming(roomMessage(5));
    await held.promise;
    f.history.push(roomMessage(1, { fromSelf: true }), roomMessage(2));
    await f.routing.subscribe(f.first.id, "native", 42, 1);
    assertEquals(f.routing.store.read().rooms[0].anchor_id, 900);
    release.resolve();
    await poll(() =>
      f.routing.inbox(f.first.id).deliveries.some((d) =>
        d.message_ids.includes(2)
      )
    );
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].message_ids, [5, 2]);
  } finally {
    release.resolve();
    await f.close();
  }
});

for (const rejoin of ["explicit", "send"] as const) {
  Deno.test(`last leave cancels unclaimed work; ${rejoin} rejoin excludes the unsubscribed interval`, async () => {
    const f = await routingFixture();
    try {
      await f.routing.subscribe(f.first.id, "native", 42);
      f.incoming(roomMessage(5));
      await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
      const old = f.routing.inbox(f.first.id).deliveries[0];
      f.routing.leave(f.first.id, "native", 42);
      assertEquals(
        f.routing.inbox(f.first.id).deliveries[0].outcome,
        "cancelled",
      );
      assertThrows(() =>
        f.routing.claim(f.first.id, old.delivery_id, crypto.randomUUID())
      );
      f.incoming(roomMessage(77));
      if (rejoin === "send") {
        f.history.push(roomMessage(1, { fromSelf: true }), roomMessage(2));
        await f.routing.subscribe(f.first.id, "native", 42, 1);
      } else {
        await f.routing.subscribe(f.first.id, "native", 42);
        f.incoming(roomMessage(2));
      }
      await poll(() =>
        f.routing.inbox(f.first.id).deliveries.some((d) => d.state === "ready")
      );
      const ready = f.routing.inbox(f.first.id).deliveries.filter((d) =>
        d.state === "ready"
      );
      assertEquals(ready.map((d) => d.message_ids), [[2]]);
      assert(ready.every((d) => d.delivery_id !== old.delivery_id));
    } finally {
      await f.close();
    }
  });
}

Deno.test("claimed work keeps its owner across last leave/rejoin; release cannot leak it into the new interval", async () => {
  const f = await routingFixture();
  try {
    await f.routing.subscribe(f.first.id, "one", 42);
    f.incoming(roomMessage(5));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    const d = f.routing.inbox(f.first.id).deliveries[0];
    const claim = f.routing.claim(
      f.first.id,
      d.delivery_id,
      crypto.randomUUID(),
    );
    f.incoming(roomMessage(6));
    await poll(() =>
      f.routing.inbox(f.first.id).deliveries.some((row) =>
        row.state === "ready"
      )
    );
    const releasing = f.routing.inbox(f.first.id).deliveries.find((row) =>
      row.state === "ready"
    )!;
    const releaseClaim = f.routing.claim(
      f.first.id,
      releasing.delivery_id,
      crypto.randomUUID(),
    );
    f.routing.leave(f.first.id, "one", 42);
    await f.routing.subscribe(f.second.id, "two", 42);
    assertEquals(
      f.routing.claim(f.first.id, d.delivery_id, claim.claimant!).claim_token,
      claim.claim_token,
    );
    const body = await f.routing.bodies(
      f.first.id,
      d.delivery_id,
      claim.claim_token!,
    );
    assertEquals(body.messages.map((m) => m.id), [5]);
    const sent = await f.routing.mirror(
      f.first.id,
      d.delivery_id,
      claim.claim_token!,
      "claimed work can finish",
    );
    assertEquals(sent.mirror, "sent");
    f.routing.complete(
      f.first.id,
      d.delivery_id,
      claim.claim_token!,
      "mirrored",
    );
    f.routing.release(
      f.first.id,
      releasing.delivery_id,
      releaseClaim.claim_token!,
    );
    assertEquals(
      f.routing.inbox(f.first.id).deliveries.find((row) =>
        row.delivery_id === releasing.delivery_id
      )!.outcome,
      "cancelled",
    );
    assertEquals(f.routing.inbox(f.second.id).deliveries, []);
  } finally {
    await f.close();
  }
});

Deno.test("a scan snapshot from an ended interval cannot commit against a fresh interval with the same anchor", async () => {
  const f = await routingFixture();
  const read = f.chats.routingMessages;
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let once = true;
  try {
    await f.routing.subscribe(f.first.id, "native", 42);
    f.chats.routingMessages = async (chat, after) => {
      const page = await read(chat, after);
      if (once) {
        once = false;
        held.resolve();
        await release.promise;
      }
      return page;
    };
    f.incoming(roomMessage(17));
    await held.promise;
    f.routing.leave(f.first.id, "native", 42);
    f.history.splice(f.history.findIndex((m) => m.id === 17), 1);
    await f.routing.subscribe(f.first.id, "native", 42);
    release.resolve();
    f.incoming(roomMessage(2));
    await poll(() =>
      f.routing.inbox(f.first.id).deliveries.some((d) =>
        d.message_ids.includes(2)
      )
    );
    assertEquals(
      f.routing.inbox(f.first.id).deliveries.filter((d) => d.state === "ready")
        .map((d) => d.message_ids),
      [[2]],
    );
  } finally {
    release.resolve();
    await f.close();
  }
});
