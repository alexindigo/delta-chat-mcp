// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";

/** Service bookkeeping only. Delta Chat core owns all message history. */
export function openStateDb(dataDir: string): DatabaseSync {
  Deno.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "app.sqlite"));
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 1);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
