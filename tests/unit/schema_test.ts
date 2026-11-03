// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "@std/assert";
import { openStateDb } from "../../src/state/db.ts";
import { fixture } from "../support.ts";

Deno.test("M0 schema upgrades transactionally with access and metadata-only room routing", async () => {
  const dir = await fixture("schema");
  const old = new DatabaseSync(`${dir}/app.sqlite`);
  old.exec(
    "CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT; INSERT INTO schema_version VALUES (1,1)",
  );
  old.close();
  const db = openStateDb(dir);
  try {
    assertEquals(
      db.prepare("SELECT version FROM schema_version WHERE id=1").get()
        ?.version,
      3,
    );
    assertEquals(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all().map((row) => row.name),
      ["api_keys", "room_routing", "schema_version"],
    );
    assertEquals(
      db.prepare("PRAGMA table_info(api_keys)").all().map((row) => row.name),
      ["digest", "name", "created_at", "last_used_at"],
    );
  } finally {
    db.close();
  }
});
