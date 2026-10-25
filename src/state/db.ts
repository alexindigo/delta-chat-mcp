// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { migrateState } from "./schema.ts";

/** Service bookkeeping only. Delta Chat core owns all message history. */
export function openStateDb(dataDir: string): DatabaseSync {
  Deno.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "app.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    migrateState(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
