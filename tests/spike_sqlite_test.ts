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
      1,
    );
    // Fixture-owned table: no production message or agent state is introduced.
    first.exec(
      "CREATE TABLE spike_value (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT",
    );
    first.prepare("INSERT INTO spike_value (id, value) VALUES (?, ?)").run(
      1,
      "survives close",
    );
  } finally {
    first.close();
  }
  assert((await Deno.stat(`${dir}/app.sqlite`)).size > 0);
  const reopened = openStateDb(dir);
  try {
    assertEquals(
      reopened.prepare("SELECT value FROM spike_value WHERE id = ?").get(1)
        ?.value,
      "survives close",
    );
    assertEquals(
      reopened.prepare("SELECT COUNT(*) AS count FROM schema_version").get()
        ?.count,
      1,
    );
    assertEquals(
      reopened.prepare("SELECT version FROM schema_version").get()?.version,
      1,
    );
    assertEquals(
      reopened.prepare("PRAGMA journal_mode").get()?.journal_mode,
      "wal",
    );
    console.log(`disk row=survives close; schema=1; WAL; ${dir}/app.sqlite`);
  } finally {
    reopened.close();
  }
});
