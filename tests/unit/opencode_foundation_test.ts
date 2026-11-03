// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  parseOptions,
  resolveServers,
} from "../../integrations/opencode/options.ts";
import { OpenCode } from "../../integrations/opencode/opencode.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { fixture } from "../support.ts";

Deno.test("plugin aliases are required, resolved from existing config, and cannot supply separate credentials", () => {
  assertThrows(() => parseOptions({}));
  assertThrows(() => parseOptions({ servers: [] }));
  assertThrows(() => parseOptions({ servers: ["relay"], headers: {} }));
  assertThrows(() =>
    parseOptions({ servers: ["relay"], stateFile: "relative" })
  );
  const options = parseOptions({ servers: ["relay", "relay"] });
  assertEquals(options.servers, ["relay"]);
  assertEquals(options.waitSeconds, 300);
  const servers = resolveServers({
    mcp: {
      relay: {
        type: "remote",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "Bearer test-only" },
        enabled: false,
      },
    },
  }, options);
  assertEquals(servers[0].enabled, false);
  assertEquals(servers[0].headers, { Authorization: "Bearer test-only" });
  assertThrows(() =>
    resolveServers({
      mcp: {
        relay: {
          type: "remote",
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "Bearer {env:KEY}" },
        },
      },
    }, options)
  );
});

Deno.test("registry transactions atomically retain routing and stable submission identity, enforce epochs, leases and terminal retention", async () => {
  const root = await fixture("opencode-foundation");
  const db = await openSqlite(`${root}/wake.sqlite`);
  const registry = new Registry(db);
  try {
    const sub = {
      session_id: "ses_test",
      relay: "test@example.invalid",
      chat_id: 42,
      directory: "/test/A",
      owner_server: "http://127.0.0.1:4097/",
      alias: "fixture",
      state: "active" as const,
      anchor_id: 10,
      recent_ids: [10],
      created_at: 1,
      updated_at: 1,
      left_at: null,
    };
    assertThrows(() =>
      registry.write((tx) => {
        tx.putSubscription(sub);
        throw new Error("rollback");
      })
    );
    assertEquals(registry.subscriptions(), []);
    const id = crypto.randomUUID();
    registry.write((tx) => {
      tx.putSubscription({ ...sub, anchor_id: 11, recent_ids: [10, 11] });
      tx.putDelivery({
        id,
        session_id: sub.session_id,
        relay: sub.relay,
        chat_id: 42,
        from_anchor: 10,
        message_ids: [11],
        state: "open",
        user_message_id: null,
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
    });
    const epoch = crypto.randomUUID();
    const first = registry.write((tx) =>
      tx.allocateSubmission(id, epoch, 0, 100)
    );
    assertEquals(registry.submissions(id), [first]);
    assertEquals(registry.deliveries()[0].state, "submitting");
    const again = registry.write((tx) =>
      tx.allocateSubmission(id, crypto.randomUUID(), 0, 200)
    );
    assertEquals(again, first);
    assertThrows(() =>
      registry.write((tx) => tx.updateSubmission({ ...first, attempts: 2 }))
    );
    registry.write((tx) =>
      tx.updateSubmission({
        ...first,
        attempts: 2,
        submit_epoch: crypto.randomUUID(),
        updated_at: 200,
      })
    );
    assertEquals(registry.submissions(id)[0].message_id, first.message_id);
    assertThrows(() =>
      registry.write((tx) =>
        tx.updateSubmission({
          ...first,
          message_id: first.message_id.replace("msg_", "msg_0"),
        })
      )
    );
    assertEquals(
      registry.write((tx) =>
        tx.acquireLease(sub.session_id, "one", "http://wrong.invalid/", 1)
      ),
      false,
    );
    assert(
      registry.write((tx) =>
        tx.acquireLease(sub.session_id, "one", sub.owner_server, 1)
      ),
    );
    assertEquals(
      registry.write((tx) =>
        tx.acquireLease(sub.session_id, "two", sub.owner_server, 2)
      ),
      false,
    );
    assertEquals(
      registry.write((tx) =>
        tx.tryAcquireLease(sub.session_id, "two", sub.owner_server, 2)
      ),
      { acquired: false, retryAt: 90_001 },
    );
    assertEquals(
      registry.write((tx) =>
        tx.tryAcquireLease(sub.session_id, "two", "http://wrong.invalid/", 2)
      ),
      { acquired: false, retryAt: null },
    );
    assert(
      registry.write((tx) =>
        tx.acquireLease(sub.session_id, "two", sub.owner_server, 100_000)
      ),
    );
    assertThrows(() =>
      registry.write((tx) => tx.transition(id, "submitting", "mirrored", 200))
    );
    registry.write((tx) => {
      tx.transition(id, "submitting", "admitted", 200);
      tx.transition(id, "admitted", "interrupted_unanswered", 200);
    });
    assertThrows(() =>
      registry.write((tx) =>
        tx.transition(id, "interrupted_unanswered", "open", 300)
      )
    );
    registry.write((tx) => tx.prune(201));
    assertEquals(registry.deliveries().length, 1);
    registry.write((tx) => tx.prune(200 + 7 * 86400_000 + 1));
    assertEquals(registry.deliveries(), []);
    assertEquals(registry.submissions(id), []);
    assertEquals(db.get("PRAGMA synchronous")?.synchronous, 2);
    assertEquals(db.get("PRAGMA journal_mode")?.journal_mode, "wal");
    const columns = ["subscription", "delivery", "submission", "lease"].flatMap(
      (table) => db.all(`PRAGMA table_info(${table})`).map((r) => r.name),
    );
    for (
      const forbidden of [
        "text",
        "body",
        "html",
        "content",
        "payload",
        "error_text",
      ]
    ) assert(!columns.includes(forbidden));
  } finally {
    registry.close();
  }
});

Deno.test("OpenCode boundary validates runtime shapes, preserves selection, and never guesses disabled/missing catalog entries", async () => {
  const oc = new OpenCode({
    mcp: {
      status: () =>
        Promise.resolve({
          data: {
            disabled: { status: "disabled" },
            failed: { status: "failed" },
          },
        }),
    },
  });
  assertEquals(await oc.aliasEnabled("disabled"), false);
  assertEquals(await oc.aliasEnabled("absent"), false);
  assertEquals(await oc.aliasEnabled("failed"), true);
  await assertRejects(() =>
    new OpenCode({
      session: { status: () => Promise.resolve({ data: "invalid" }) },
    }).status()
  );
  const selection = oc.selection({
    id: "ses_test",
    agent: "selected",
    model: { providerID: "test", id: "test-model", variant: "careful" },
  });
  assertEquals(selection, {
    agent: "selected",
    model: { providerID: "test", modelID: "test-model" },
    variant: "careful",
  });
});
