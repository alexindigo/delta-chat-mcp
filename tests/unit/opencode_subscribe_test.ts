// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import plugin from "../../integrations/opencode/mod.ts";
import {
  parseOptions,
  resolveServerRoutes,
} from "../../integrations/opencode/options.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import {
  Subscribe,
  type SubscriptionRelay,
} from "../../integrations/opencode/subscribe.ts";
import type { Delivery } from "../../integrations/opencode/types.ts";
import { fixture } from "../support.ts";

async function world() {
  const registry = new Registry(await openSqlite(":memory:"));
  const relays = new Map<string, SubscriptionRelay>();
  const reads: unknown[] = [];
  const relay = (address: string): SubscriptionRelay => ({
    identity: () => Promise.resolve(address),
    health: { state: "connected", retryAt: 0 },
    call(_name, args) {
      reads.push(args);
      return args.after_id === 22
        ? Promise.resolve({ messages: [] })
        : Promise.reject(new Error("not_found secret"));
    },
  });
  relays.set("one.alias", relay("one@example.invalid"));
  relays.set("same", relay("one@example.invalid"));
  relays.set("other", relay("two@example.invalid"));
  const notices: string[] = [];
  const signal = new AbortController();
  const make = (owner = "http://127.0.0.1:1/") =>
    new Subscribe({
      registry: () => registry,
      directory: "/project",
      owner,
      aliases: [...relays.keys()],
      relays,
      unroutable: new Set(),
      signal: signal.signal,
      toast: (text) => {
        notices.push(text);
        return Promise.resolve();
      },
    });
  const subscribe = make();
  const send = async (
    alias = "one.alias",
    message = 10,
    session = "ses_one",
    handler = subscribe,
  ) => {
    const payload = { message_id: message, chat_id: 42, state: "sent" };
    const result = {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
    await handler.after({
      tool: `${alias.replaceAll(".", "_")}_send_message`,
      sessionID: session,
    }, result);
    return result;
  };
  return { registry, subscribe, send, make, reads, relays, notices };
}

Deno.test("J3 exact sanitized send boundary, canonical alias dedup and per-writer anchors", async () => {
  const w = await world();
  try {
    const result = await w.send();
    assertEquals(result.structuredContent, {
      message_id: 10,
      chat_id: 42,
      state: "sent",
    });
    assertStringIncludes(result.content[1].text, "this session is subscribed");
    await w.send("same", 11);
    await w.send("other", 12);
    await w.send("same", 13, "ses_two");
    const rows = w.registry.subscriptions();
    assertEquals(rows.length, 3);
    assertEquals(
      rows.filter((r) => r.session_id === "ses_one").map((r) => r.anchor_id),
      [10, 12],
    );
    assertEquals(
      rows.find((r) => r.session_id === "ses_one" && r.relay.startsWith("one"))!
        .alias,
      "same",
    );
    const tools = w.subscribe.tools();
    const list = JSON.parse(
      await tools.delta_chat_room_subscriptions.execute({}, {
        sessionID: "ses_two",
      }),
    );
    assertEquals(list.subscriptions.length, 1);
    assertEquals(list.subscriptions[0].anchor_id, 13);
    for (
      const tool of [
        "one.alias_send_message",
        "one_alias_send_message_extra",
        "unconfigured_send_message",
      ]
    ) {
      await w.subscribe.after({ tool, sessionID: "ses_three" }, {
        content: [],
        structuredContent: { message_id: 100, chat_id: 42 },
      });
    }
    assertEquals(w.registry.subscriptions("ses_three"), []);
  } finally {
    w.registry.close();
  }
});

Deno.test("J3 unsuccessful or invalid results do not subscribe; observation never throws or leaks raw errors", async () => {
  const w = await world();
  try {
    const call = { tool: "one_alias_send_message", sessionID: "ses_one" };
    const error = { isError: true, content: [] };
    await w.subscribe.after(call, error);
    assertEquals(error.content, []);
    for (
      const payload of [{ message_id: 0, chat_id: 42 }, {
        message_id: 1,
        chat_id: -2,
      }]
    ) {
      const result = {
        structuredContent: payload,
        content: [] as { text: string }[],
      };
      await w.subscribe.after(call, result);
      assertStringIncludes(result.content[0].text, "NOT recorded");
      assertEquals(result.structuredContent, payload);
    }
    assertEquals(w.registry.subscriptions(), []);
    w.relays.delete("one.alias");
    const result = await w.send();
    assertStringIncludes(result.content[1].text, "NOT recorded");
    assert(!JSON.stringify(result).includes("secret"));
  } finally {
    w.registry.close();
  }
});

Deno.test("J3 code-mode notices follow only the exact child-call/session to its outer output without changing remote structured results", async () => {
  const w = await world();
  try {
    const remote = {
      structuredContent: { message_id: 10, chat_id: 42 },
      content: [] as { text: string }[],
    };
    await w.subscribe.after({
      tool: "one_alias_send_message",
      sessionID: "ses_one",
      callID: "call_outer/1",
    }, remote);
    assertEquals(remote.structuredContent, { message_id: 10, chat_id: 42 });
    const unrelated = { output: "original" };
    await w.subscribe.after({
      tool: "execute",
      sessionID: "ses_other",
      callID: "call_outer",
    }, unrelated);
    assertEquals(unrelated.output, "original");
    const outer = { output: "original" };
    await w.subscribe.after({
      tool: "execute",
      sessionID: "ses_one",
      callID: "call_outer",
    }, outer);
    assertStringIncludes(
      outer.output,
      "original\n\ndelta-chat-mcp: this session is subscribed",
    );
    assertEquals(w.registry.subscriptions().length, 1);
  } finally {
    w.registry.close();
  }
});

Deno.test("J3 leave cancels queued work, preserves in-flight admission/completion, and own send reactivates only own row", async () => {
  const w = await world();
  try {
    await w.send();
    await w.send("same", 11, "ses_two");
    const sub = w.registry.subscriptions("ses_one")[0];
    const delivery = (state: Delivery["state"]): Delivery => ({
      id: crypto.randomUUID(),
      session_id: sub.session_id,
      relay: sub.relay,
      chat_id: 42,
      from_anchor: 10,
      message_ids: [20],
      state,
      user_message_id: state === "admitted" ? "msg_admitted" : null,
      attempts: 0,
      continuations: 0,
      model_sent_ids: [],
      mirror_message_ids: [],
      superseding_message_id: null,
      reason: null,
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    });
    const queued = delivery("open"),
      admitted = delivery("admitted"),
      pending = delivery("submitted");
    w.registry.write((tx) => {
      for (const row of [queued, admitted, pending]) tx.putDelivery(row);
    });
    const tools = w.subscribe.tools();
    assertEquals(
      JSON.parse(
        await tools.delta_chat_room_leave.execute({
          server: "one.alias",
          chat_id: 42,
        }, { sessionID: "ses_one" }),
      ).state,
      "left",
    );
    assertEquals(w.registry.deliveries().map((d) => d.state).sort(), [
      "admitted",
      "cancelled",
      "submitted",
    ]);
    assertEquals(w.registry.subscriptions("ses_two")[0].state, "active");
    await w.send("same", 30);
    assertEquals(w.registry.subscriptions("ses_one")[0].anchor_id, 30);
  } finally {
    w.registry.close();
  }
});

Deno.test("J3 blocked resume is explicit, session-scoped and validates an existing core chat anchor", async () => {
  const w = await world();
  try {
    await w.send();
    const row = w.registry.subscriptions()[0];
    w.registry.write((tx) =>
      tx.putSubscription({ ...row, state: "blocked_discontinuity" })
    );
    await w.send("same", 19);
    assertEquals(w.registry.subscriptions()[0].state, "blocked_discontinuity");
    const resume = w.subscribe.tools().delta_chat_room_resume;
    for (
      const [session, after] of [["ses_one", 21], ["ses_other", 22]] as const
    ) {
      assert(
        JSON.parse(
          await resume.execute(
            { server: "same", chat_id: 42, after_id: after },
            { sessionID: session },
          ),
        ).error,
      );
      assertEquals(w.registry.subscriptions()[0].anchor_id, 10);
    }
    const result = JSON.parse(
      await resume.execute({ server: "same", chat_id: 42, after_id: 22 }, {
        sessionID: "ses_one",
      }),
    );
    assertEquals(result.anchor_id, 22);
    assertEquals(w.registry.subscriptions()[0].recent_ids, [22]);
    assertEquals(w.reads, [{ chat_id: 42, after_id: 21, limit: 1 }, {
      chat_id: 42,
      after_id: 22,
      limit: 1,
    }]);
  } finally {
    w.registry.close();
  }
});

Deno.test("J3 historical ownership cannot poison a live session lease; legitimate send transfers all live ownership atomically", async () => {
  const w = await world();
  try {
    await w.send();
    await w.send("other", 11);
    await w.send("same", 12, "ses_other");
    const history = {
      ...w.registry.subscriptions("ses_one")[0],
      chat_id: 50,
      owner_server: "http://old.invalid/",
      state: "left" as const,
      left_at: 1,
    };
    w.registry.write((tx) => tx.putSubscription(history));
    assert(
      w.registry.write((tx) =>
        tx.acquireLease("ses_one", "old", "http://127.0.0.1:1/", 1)
      ),
    );
    await w.send("same", 99, "ses_one", w.make("http://127.0.0.1:2/"));
    assertEquals(
      w.registry.subscriptions("ses_one").filter((r) => r.state === "active")
        .map((r) => [r.owner_server, r.anchor_id]),
      [["http://127.0.0.1:2/", 10], ["http://127.0.0.1:2/", 11]],
    );
    assertEquals(
      w.registry.subscriptions("ses_other")[0].owner_server,
      "http://127.0.0.1:1/",
    );
    assert(
      w.registry.write((tx) =>
        tx.acquireLease("ses_one", "new", "http://127.0.0.1:2/", 2)
      ),
    );
    assertEquals(
      w.registry.write((tx) =>
        tx.acquireLease("ses_other", "new", "http://127.0.0.1:2/", 2)
      ),
      false,
    );
  } finally {
    w.registry.close();
  }
});

Deno.test("J3 alias resolution isolates missing, invalid and sanitized collisions without exposing credentials", () => {
  const options = parseOptions({
    servers: ["good", "missing", "invalid", "a.b", "a_b"],
  });
  const routes = resolveServerRoutes({
    mcp: {
      good: {
        type: "remote",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "Bearer test-only" },
      },
      invalid: { type: "local" },
      "a.b": { type: "remote", url: "http://127.0.0.1:2/mcp" },
      a_b: { type: "remote", url: "http://127.0.0.1:3/mcp" },
    },
  }, options);
  assertEquals(routes.servers.map((s) => s.alias), ["good"]);
  assertEquals([...routes.unroutable], ["missing", "invalid", "a.b", "a_b"]);
});

Deno.test("J3 list exposes unroutable current rows independently and durable leave works without relay I/O", async () => {
  const w = await world();
  try {
    await w.send();
    await w.send("other", 11);
    w.relays.delete("one.alias");
    const tools = w.subscribe.tools();
    const list = JSON.parse(
      await tools.delta_chat_room_subscriptions.execute({}, {
        sessionID: "ses_one",
      }),
    );
    assertEquals(list.subscriptions.map((r: { state: string }) => r.state), [
      "unroutable",
      "active",
    ]);
    const left = JSON.parse(
      await tools.delta_chat_room_leave.execute(
        { server: "one_alias", chat_id: 42 },
        { sessionID: "ses_one" },
      ),
    );
    assertEquals(left.state, "left");
    assertEquals(w.registry.subscriptions()[1].state, "active");
  } finally {
    w.registry.close();
  }
});

Deno.test("modern composition preserves exact accepted results when storage is unavailable; bootstrap makes no self HTTP; consumers join before storage closes", async () => {
  const root = await fixture("j3-composition");
  const blocked = `${root}/blocked`;
  await Deno.mkdir(blocked, { mode: 0o500 });
  let selfCalls = 0;
  const hooks = await plugin({
    directory: root,
    serverUrl: new URL("http://127.0.0.1:1/"),
    client: {
      mcp: {
        status() {
          selfCalls++;
          throw new Error("bootstrap self HTTP");
        },
      },
    },
  }, {
    relays: { missing: { url: "http://127.0.0.1:1/mcp", enabled: false } },
    stateFile: `${blocked}/wake.sqlite`,
  });
  await hooks.config({ mcp: {} });
  assertEquals(selfCalls, 0);
  const result = {
    content: [] as { text: string }[],
    structuredContent: { chat_id: 42, message_id: 10 },
  };
  await hooks["tool.execute.after"]({
    tool: "missing_send_message",
    sessionID: "ses_one",
  }, result);
  assertEquals(result.content, []);
  assertEquals(result.structuredContent, { chat_id: 42, message_id: 10 });
  await hooks.dispose();
  const late = {
    content: [] as { text: string }[],
    structuredContent: { chat_id: 42, message_id: 11 },
  };
  await hooks["tool.execute.after"]({
    tool: "missing_send_message",
    sessionID: "ses_one",
  }, late);
  assertEquals(late.content, []);
  assertEquals(late.structuredContent, { chat_id: 42, message_id: 11 });
  let joined = false;
  const working = await plugin(
    { directory: root, serverUrl: new URL("http://127.0.0.1:1/"), client: {} },
    {
      relays: { missing: { url: "http://127.0.0.1:1/mcp", enabled: false } },
      stateFile: `${root}/working/wake.sqlite`,
    },
    {
      attach(f) {
        f.onStop(() => {
          assert(f.signal.aborted);
          assertEquals(f.registry.subscriptions(), []);
          joined = true;
          return Promise.resolve();
        });
        return {};
      },
    },
  );
  await working.config({ mcp: {} });
  await working.dispose();
  assert(joined);
});
