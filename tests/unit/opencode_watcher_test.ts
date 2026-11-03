// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { fixture } from "../support.ts";

Deno.test("J4 batch owner projects full subscription keys and commits human IDs with nonmonotone core anchors atomically", async () => {
  const root = await fixture("j4-batch");
  const registry = new Registry(await openSqlite(`${root}/wake.sqlite`));
  try {
    const row = registry.write((tx) =>
      tx.subscribe({
        session_id: "session",
        relay: "test@example.invalid",
        chat_id: 42,
        directory: "/A",
        owner_server: "http://localhost:4097/",
        alias: "relay",
        message_id: 90,
      }, 1)
    );
    assertThrows(() =>
      registry.write((tx) => {
        tx.recordBatch(row, 90, [5, 72, 3], [5, 3], 2);
        throw new Error("rollback");
      })
    );
    assertEquals(registry.subscriptions()[0].anchor_id, 90);
    assertEquals(registry.deliveries(), []);
    registry.write((tx) => tx.recordBatch(row, 90, [5, 72, 3], [5, 3], 2));
    assertEquals(registry.subscriptions()[0].recent_ids, [90, 5, 72, 3]);
    assertEquals(registry.deliveries()[0].message_ids, [5, 3]);
    registry.write((tx) => tx.recordBatch(row, 3, [72, 3, 6], [3, 6], 3));
    assertEquals(registry.deliveries().length, 1);
    assertEquals(registry.deliveries()[0].message_ids, [5, 3, 6]);
    assertEquals(registry.subscriptions()[0].anchor_id, 6);
    registry.write((tx) => tx.leave(row, 4));
    registry.write((tx) => tx.recordBatch(row, 6, [1], [1], 5));
    assertEquals(registry.subscriptions()[0].anchor_id, 6);
    assertEquals(registry.deliveries()[0].state, "cancelled");
  } finally {
    registry.close();
  }
});

Deno.test("J4 ring retains exactly32 contiguous processed core positions across page replay", async () => {
  const root = await fixture("j4-ring");
  const registry = new Registry(await openSqlite(`${root}/wake.sqlite`));
  try {
    const row = registry.write((tx) =>
      tx.subscribe({
        session_id: "session",
        relay: "test@example.invalid",
        chat_id: 42,
        directory: "/A",
        owner_server: "http://localhost:4097/",
        alias: "relay",
        message_id: 9000,
      }, 1)
    );
    const core = Array.from({ length: 40 }, (_, i) => 1000 - i * 7);
    registry.write((tx) =>
      tx.recordBatch(row, 9000, core.slice(0, 25), [core[0]], 2)
    );
    registry.write((tx) =>
      tx.recordBatch(row, core[24], core.slice(20), [core[30], core[39]], 3)
    );
    assertEquals(registry.subscriptions()[0].recent_ids, core.slice(-32));
    assertEquals(registry.subscriptions()[0].anchor_id, core[39]);
    assertEquals(registry.deliveries()[0].message_ids, [
      core[0],
      core[30],
      core[39],
    ]);
    registry.write((tx) =>
      tx.recordBatch(
        row,
        core[39],
        [...core.slice(24), 7777],
        [core[39], 7777],
        4,
      )
    );
    assertEquals(registry.deliveries()[0].message_ids, [
      core[0],
      core[30],
      core[39],
      7777,
    ]);
    assertEquals(registry.subscriptions()[0].recent_ids, [
      ...core.slice(-31),
      7777,
    ]);
  } finally {
    registry.close();
  }
});
