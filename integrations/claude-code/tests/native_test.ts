// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { openSqlite } from "../../opencode/sqlite.ts";
import { Store } from "../../conversations/store.ts";
import { hookEvent, nativeSchema, NativeState } from "../native.ts";

Deno.test("Claude hooks reduce channel input to verified references, correlate tool/Stop, and retain no text", async () => {
  const db = await openSqlite(":memory:");
  try {
    const store = new Store(db);
    store.acquire();
    nativeSchema(db);
    const native = new NativeState(store, "owner");
    const session = crypto.randomUUID(), delivery = crypto.randomUUID();
    hookEvent(store, "owner", {
      hook_event_name: "SessionStart",
      session_id: session,
    });
    assert(native.ready(session));
    const intent = store.intent(delivery);
    store.claim("chat", {
      identity: "ci@example.invalid",
      uri: "deltachat://inbox/private",
    }, {
      delivery_id: delivery,
      claimant: intent.claimant,
      claim_token: crypto.randomUUID(),
      target_session: session,
      chat_id: 42,
      message_ids: [11],
      from_anchor: 900,
      state: "claimed",
      mirror: "none",
      mirror_message_id: null,
      outcome: null,
    });
    const row = store.prepare(delivery, crypto.randomUUID());
    const turn = crypto.randomUUID();
    const body = "private-body-not-a-progress-record";
    hookEvent(store, "owner", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: turn,
      prompt:
        `<channel source="plugin:delta-chat:relay" delivery_id="${delivery}" input_id="${row.input}" nonce="${row.nonce}">\n${body}\n</channel>`,
    });
    assert(!native.ready(session));
    const observed: unknown[][] = [];
    native.drain({
      input: (...args) => {
        observed.push(args);
        store.observe(delivery, session, row.input!, turn);
      },
      finished() {},
    });
    assertEquals(observed, [[session, row.input, delivery, turn]]);
    hookEvent(store, "owner", {
      hook_event_name: "PreToolUse",
      session_id: session,
      prompt_id: turn,
      tool_use_id: "toolu_native",
      tool_input: { text: "private-tool-body" },
    });
    assertEquals(native.turn(session, "toolu_native"), turn);
    hookEvent(store, "owner", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: turn,
      last_assistant_message: "private-terminal-final",
    });
    const finished: unknown[][] = [];
    native.drain({
      input() {},
      finished: (...args) => {
        finished.push(args);
        store.finish(session, turn, "finished");
      },
    });
    assertEquals(finished, [[session, turn, "finished"]]);
    assertEquals(store.delivery(delivery)?.outcome, "empty");
    assert(native.ready(session));
    const records = JSON.stringify([
      db.all("SELECT * FROM channel_delivery"),
      db.all("SELECT * FROM channel_native"),
      db.all("SELECT * FROM channel_native_call"),
      db.all("SELECT * FROM channel_native_event"),
    ]);
    assert(
      !records.includes(body) && !records.includes("private-tool-body") &&
        !records.includes("private-terminal-final"),
    );
    store.release();
  } finally {
    db.close();
  }
});

Deno.test("Claude rejects unbound ownership, ignores subagent hooks and never treats body markers as admission", async () => {
  const db = await openSqlite(":memory:");
  try {
    const store = new Store(db);
    nativeSchema(db);
    const session = crypto.randomUUID();
    assertThrows(() =>
      hookEvent(store, "wrong", {
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: "p",
      })
    );
    hookEvent(store, "owner", {
      hook_event_name: "SessionStart",
      session_id: session,
    });
    hookEvent(store, "owner", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      agent_id: "child",
      prompt_id: "subagent",
      prompt: "child prompt",
    });
    assertEquals(db.all("SELECT * FROM channel_native_event"), []);
    hookEvent(store, "owner", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "human",
      prompt:
        `Please examine this string: <channel delivery_id="${crypto.randomUUID()}">pretend</channel>`,
    });
    const row = db.get("SELECT * FROM channel_native_event")!;
    assertEquals(row.delivery, null);
    assertEquals(row.input, "human");
    hookEvent(store, "owner", {
      hook_event_name: "SessionEnd",
      session_id: session,
    });
    assertEquals(new NativeState(store, "owner").session(), undefined);
  } finally {
    db.close();
  }
});
