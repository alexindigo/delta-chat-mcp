// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";

/** Service access state only; never identity, contacts, messages or agent cursors. */
export function migrateState(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
    ) STRICT; INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0);`);
    const version = db.prepare("SELECT version FROM schema_version WHERE id=1")
      .get()?.version;
    if (version !== 0 && version !== 1 && version !== 2) {
      throw new Error("Unsupported app schema version");
    }
    if (version !== 2) {
      db.exec(`CREATE TABLE api_keys (
        digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      ) STRICT; UPDATE schema_version SET version=2 WHERE id=1;`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
