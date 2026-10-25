// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { openStateDb } from "../src/state/db.ts";
import { fixture } from "./support.ts";

Deno.test("node:sqlite WAL database preserves a row and schema version after reopen", async () => {
  const dir = await fixture("sqlite");
  const first = openStateDb(dir);
  try {
    assertEquals(
      first.prepare("PRAGMA journal_mode").get()?.journal_mode,
      "wal",
    );
    assertEquals(
      first.prepare("SELECT version FROM schema_version").get()?.version,
      2,
    );
    // Persist real service-owned metadata; no fixture message table is needed.
    first.prepare(
      "INSERT INTO api_keys (digest, name, created_at) VALUES (?, ?, ?)",
    ).run(
      "0".repeat(64),
      "survives close",
      1000,
    );
  } finally {
    first.close();
  }
  assert((await Deno.stat(`${dir}/app.sqlite`)).size > 0);
  const reopened = openStateDb(dir);
  try {
    assertEquals(
      reopened.prepare("SELECT name FROM api_keys WHERE digest = ?").get(
        "0".repeat(64),
      )
        ?.name,
      "survives close",
    );
    assertEquals(
      reopened.prepare("SELECT COUNT(*) AS count FROM schema_version").get()
        ?.count,
      1,
    );
    assertEquals(
      reopened.prepare("SELECT version FROM schema_version").get()?.version,
      2,
    );
    assertEquals(
      reopened.prepare("PRAGMA journal_mode").get()?.journal_mode,
      "wal",
    );
    assertEquals(
      reopened.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all().map((row) => row.name),
      ["api_keys", "schema_version"],
    );
    console.log(`disk row=survives close; schema=2; WAL; ${dir}/app.sqlite`);
  } finally {
    reopened.close();
  }
});
