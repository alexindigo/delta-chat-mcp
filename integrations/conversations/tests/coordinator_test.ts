// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Coordinator, type Host, type Relay } from "../coordinator.ts";
import { type Delivery, Store } from "../store.ts";
import { configuration } from "../config.ts";
import { ModernRelay, payload } from "../../opencode/modern-relay.ts";
import { openSqlite } from "../../opencode/sqlite.ts";
import { object } from "../../opencode/types.ts";
import {
  roomMessage,
  routingFixture,
} from "../../../tests/room_routing_support.ts";
import { poll } from "../../../tests/support.ts";

async function fixture() {
  const f = await routingFixture();
  const db = await openSqlite(":memory:");
  const store = new Store(db);
  store.acquire();
  const relay = new ModernRelay({
    alias: "chat",
    url: "http://relay.invalid/mcp",
    enabled: true,
    headers: { Authorization: `Bearer ${f.first.key}` },
  }, f.fetcher);
  const admissions: { row: Delivery; text: string }[] = [];
  const notices: string[] = [];
  const turns = new Map<string, string>();
  let busy = false;
  let admit: (row: Delivery) => Promise<void> = () => Promise.resolve();
  const host: Host = {
    inputID: () => crypto.randomUUID(),
    ready: () => Promise.resolve(!busy),
    admit: async (row, text) => {
      admissions.push({ row, text });
      await admit(row);
    },
    tool: (alias, name) => `${alias}_${name}`,
    turn: (session) => turns.get(session),
    notice: (text) => notices.push(text),
  };
  const c = new Coordinator(store, new Map([["chat", relay]]), host);
  return {
    ...f,
    db,
    store,
    relay,
    c,
    host,
    admissions,
    notices,
    turns,
    busy(value: boolean) {
      busy = value;
    },
    onAdmit(value: typeof admit) {
      admit = value;
    },
    async close() {
      await c.close();
      db.close();
      await f.close();
    },
  };
}

Deno.test("advertised tools retain schemas, hide receiver controls and reject model session overrides", async () => {
  const f = await fixture();
  try {
    const tools = await f.c.catalog();
    assertEquals(tools.length, 12);
    assert(
      !tools.some((t) =>
        t.name.startsWith("inbox_") || t.name === "wait_for_messages"
      ),
    );
    assert(
      !("session_id" in object(
        tools.find((t) => t.name === "room_subscribe")!.inputSchema.properties,
      )),
    );
    await f.c.call(
      "chat",
      "room_subscribe",
      { chat_id: 42, session_id: "forged" },
      "native",
      "call1",
    );
    assertEquals(
      f.routing.subscriptions(f.first.id, "forged").subscriptions,
      [],
    );
    assertEquals(
      f.routing.subscriptions(f.first.id, "native").subscriptions.length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test("notification-driven input keeps full facts and only an explicit correlated send answers a batch", async () => {
  const f = await fixture();
  try {
    await f.c.call(
      "chat",
      "room_subscribe",
      { chat_id: 42 },
      "native",
      "subscribe",
    );
    f.c.start();
    const text = "complete\n".repeat(1400);
    f.incoming(
      roomMessage(11, {
        text,
        isForwarded: true,
        quote: { text: "exact quoted text", authorName: "Original" },
      }),
    );
    await poll(() => Promise.resolve(f.admissions.length === 1));
    const { row, text: prompt } = f.admissions[0];
    assert(prompt.includes(JSON.stringify(text)));
    assert(
      prompt.includes("exact quoted text") &&
        prompt.includes('"isForwarded":true'),
    );
    assert(prompt.includes("Terminal answers are not sent automatically"));
    assertEquals(f.sent.length, 1); // The labelled recipient notice only.
    f.c.input("native", row.input!, row.id);
    f.turns.set("native", row.input!);
    const sent = payload(
      await f.c.call(
        "chat",
        "send_message",
        { chat_id: 42, text: "Explicit answer" },
        "native",
        "send1",
      ),
    );
    assert(Number(sent.message_id) > 0);
    await f.c.call(
      "chat",
      "send_message",
      { chat_id: 42, text: "Explicit answer" },
      "native",
      "send1",
    );
    assertEquals(f.sent.filter((s) => s.text === "Explicit answer").length, 1);
    f.c.finished("native", row.input!);
    await poll(() =>
      Promise.resolve(f.store.delivery(row.id)?.state === "completed")
    );
    assertEquals(f.store.delivery(row.id)?.outcome, "answered_by_model");
    assertEquals(
      f.routing.subscriptions(f.first.id, "native").subscriptions[0]
        .deliveries[0].mirror,
      "none",
    );
    const columns = f.db.all("PRAGMA table_info(channel_delivery)").map((r) =>
      r.name
    );
    assert(!columns.some((name) => /body|text|answer/.test(String(name))));
  } finally {
    await f.close();
  }
});

Deno.test("terminal-only turn completes empty, busy backlog batches, and uncertain input is never replayed", async () => {
  const f = await fixture();
  try {
    await f.c.call(
      "chat",
      "room_subscribe",
      { chat_id: 42 },
      "native",
      "subscribe",
    );
    f.busy(true);
    f.c.start();
    f.incoming(roomMessage(11), roomMessage(12));
    await f.c.reconcile();
    assertEquals(f.admissions.length, 0);
    f.busy(false);
    await f.c.reconcile();
    const row = f.admissions[0].row;
    assertEquals(JSON.parse(row.ids), [11, 12]);
    f.c.input("native", row.input!, row.id);
    f.c.finished("native", row.input!);
    await f.c.reconcile();
    assertEquals(f.store.delivery(row.id)?.outcome, "empty");
    f.onAdmit(() => Promise.reject(new Error("Native lost response")));
    f.incoming(roomMessage(13));
    await f.c.reconcile();
    await poll(() => Promise.resolve(f.admissions.length === 2));
    await f.c.reconcile();
    await f.c.reconcile();
    assertEquals(f.admissions.length, 2);
    assertEquals(
      f.store.delivery(f.admissions[1].row.id)?.state,
      "dispatching",
    );
    assert(f.notices.some((s) => s.includes("uncertain")));
  } finally {
    await f.close();
  }
});

Deno.test("unknown send is not repeated or falsely confirmed, and a main-turn send cannot answer a room turn", async () => {
  const f = await fixture();
  try {
    await f.c.call(
      "chat",
      "room_subscribe",
      { chat_id: 42 },
      "native",
      "subscribe",
    );
    f.incoming(roomMessage(11));
    await f.c.reconcile();
    const row = f.admissions[0].row;
    f.c.input("native", row.input!, row.id);
    f.turns.set("native", "unrelated-main-turn");
    await f.c.call(
      "chat",
      "send_message",
      { chat_id: 42, text: "Main send" },
      "native",
      "main",
    );
    assertEquals(f.store.sentOutcome(row.id), "empty");
    f.turns.set("native", row.input!);
    f.failSend();
    const result = await f.c.call(
      "chat",
      "send_message",
      { chat_id: 42, text: "Uncertain answer" },
      "native",
      "uncertain",
    );
    assertEquals(object(result).isError, true);
    await assertRejects(() =>
      f.c.call(
        "chat",
        "send_message",
        { chat_id: 42, text: "Uncertain answer" },
        "native",
        "uncertain",
      )
    );
    assertEquals(f.sent.filter((s) => s.text === "Uncertain answer").length, 1);
    f.c.finished("native", row.input!);
    await f.c.reconcile();
    assertEquals(f.store.delivery(row.id)?.outcome, "stalled");
  } finally {
    await f.close();
  }
});

Deno.test("process ownership and secret resolution fail closed", async () => {
  const db = await openSqlite(":memory:");
  try {
    const first = new Store(db);
    first.acquire();
    const second = new Store(db);
    assertThrows(() => second.acquire());
    first.release();
    second.acquire();
    second.release();
    const config = configuration({
      stateFile: "/private/state.sqlite",
      relays: {
        chat: {
          url: "http://relay.invalid/mcp",
          enabled: false,
          headers: { Authorization: { env: "PRIVATE_HEADER" } },
        },
      },
    }, { PRIVATE_HEADER: "Bearer test" });
    assertEquals(config.relays[0].enabled, false);
    assertEquals(config.relays[0].headers.Authorization, "Bearer test");
    assertThrows(() =>
      configuration({
        stateFile: "/private/state.sqlite",
        relays: {
          chat: {
            url: "http://relay.invalid/mcp",
            enabled: true,
            headers: { Authorization: { env: "MISSING" } },
          },
        },
      }, {})
    );
  } finally {
    db.close();
  }
});

Deno.test("a lost local receipt never replaces an accepted send envelope with an error", async () => {
  const f = await fixture();
  const finish = f.store.finishSend.bind(f.store);
  try {
    f.store.finishSend = () => {
      throw new Error("Fixture local write failure");
    };
    const result = payload(
      await f.c.call(
        "chat",
        "send_message",
        { chat_id: 42, text: "Accepted despite receipt failure" },
        "native",
        "local-write-failure",
      ),
    );
    assert(Number(result.message_id) > 0);
    assertEquals(
      f.sent.filter((s) => s.text === "Accepted despite receipt failure")
        .length,
      1,
    );
    assertEquals(
      f.db.get("SELECT state FROM channel_send")?.state,
      "attempting",
    );
  } finally {
    f.store.finishSend = finish;
    await f.close();
  }
});

Deno.test("failed transport cleanup retains ownership and prevents a replacement receiver", async () => {
  const db = await openSqlite(":memory:");
  const store = new Store(db);
  store.acquire();
  try {
    const host: Host = {
      ready: () => Promise.resolve(true),
      inputID: () => "input",
      admit: () => Promise.resolve(),
      tool: (_alias, name) => name,
      turn: () => undefined,
      notice() {},
    };
    const broken = {
      close: () => Promise.reject(new Error("Unproven cleanup")),
    } as unknown as Relay;
    const c = new Coordinator(store, new Map([["broken", broken]]), host);
    await assertRejects(() => c.close());
    assertEquals(db.get("SELECT epoch FROM channel_owner")?.epoch, store.epoch);
    assertThrows(() => new Store(db).acquire());
  } finally {
    store.release();
    db.close();
  }
});

Deno.test("independent native sessions share a file without sharing leases, bindings, intents or send recovery", async () => {
  const db = await openSqlite(":memory:");
  const a = new Store(db, "claude:session-a"),
    b = new Store(db, "claude:session-b");
  try {
    a.acquire();
    a.prepareSend("a-send", "fingerprint", null);
    b.acquire();
    assertEquals(a.send("a-send")?.state, "attempting");
    assertEquals(b.send("a-send"), undefined);
    const scope = {
      identity: "ci@example.invalid",
      uri: "deltachat://inbox/one",
    };
    a.bind("native-a", "chat", scope);
    assert(a.bound("native-a", scope));
    assert(!b.bound("native-a", scope));
    const intent = a.intent(crypto.randomUUID());
    assertEquals(b.delivery(intent.id), undefined);
    b.settle(intent.id, "failed");
    assertEquals(a.delivery(intent.id)?.state, "intent");
    assertThrows(() => new Store(db, "claude:session-a").acquire());
    b.release();
    a.release();
  } finally {
    db.close();
  }
});

Deno.test("bindings follow canonical relay/inbox scope rather than a mutable transport alias", async () => {
  const db = await openSqlite(":memory:");
  const store = new Store(db);
  store.acquire();
  try {
    const scope = {
      identity: "ci@example.invalid",
      uri: "deltachat://inbox/key-one",
    };
    store.bind("native", "original-transport", scope);
    assert(store.bound("native", scope));
    assert(
      !store.bound("native", { ...scope, uri: "deltachat://inbox/key-two" }),
    );
    assert(
      !store.bound("native", { ...scope, identity: "other@example.invalid" }),
    );
    assert(!store.bound("other-native", scope));
  } finally {
    store.release();
    db.close();
  }
});
