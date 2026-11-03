// SPDX-License-Identifier: LGPL-3.0-only
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { versions } from "node:process";
import { object } from "./types.ts";

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;
export interface Sqlite {
  readonly runtime: "bun:sqlite" | "node:sqlite";
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  get(sql: string, ...params: SqlValue[]): Row | undefined;
  all(sql: string, ...params: SqlValue[]): Row[];
  close(): void;
}
interface Statement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown;
  finalize?(): void;
}
interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(throwOnError?: boolean): void;
}

/** C13 selects Bun in OpenCode; Deno uses its builtin Node-compatible SQLite. */
export async function openSqlite(
  path: string,
  readOnly = false,
): Promise<Sqlite> {
  const runtime = versions.bun ? "bun:sqlite" : "node:sqlite";
  if (!readOnly && path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Opening before SQLite ensures even the first database bytes are private.
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  }
  let db: Database;
  if (runtime === "bun:sqlite") {
    const specifier = "bun:sqlite";
    const module = object(await import(specifier));
    if (typeof module.Database !== "function") {
      throw new Error("Missing Bun SQLite");
    }
    const Constructor = module.Database as new (
      p: string,
      o: { readonly: boolean; create: boolean },
    ) => Database;
    db = new Constructor(path, { readonly: readOnly, create: !readOnly });
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path, { readOnly }) as unknown as Database;
  }
  const close = () => {
    // Bun's default close defers native handle release while prepare() statements
    // await GC. This adapter owns those statements: close must finalize them now.
    if (runtime === "bun:sqlite") db.close(true);
    else db.close();
  };
  const execute = (
    sql: string,
    params: SqlValue[],
    method: "run" | "get" | "all",
  ) => {
    const statement = db.prepare(sql);
    const finalize = runtime === "bun:sqlite" ? statement.finalize : undefined;
    if (runtime === "bun:sqlite" && typeof finalize !== "function") {
      throw new Error("Missing Bun SQLite statement finalizer");
    }
    try {
      return statement[method](...params);
    } finally {
      // Statements never escape this adapter. Release their locks after every
      // materialized result, including errors, rather than waiting for Bun GC.
      finalize?.call(statement);
    }
  };
  try {
    db.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
    if (readOnly) db.exec("PRAGMA query_only=ON;");
    else db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    return {
      runtime,
      exec(sql) {
        db.exec(sql);
      },
      run(sql, ...params) {
        execute(sql, params, "run");
      },
      get(sql, ...params) {
        const row = execute(sql, params, "get");
        return row == null ? undefined : object(row);
      },
      all(sql, ...params) {
        const rows = execute(sql, params, "all");
        if (!Array.isArray(rows)) throw new Error("Invalid SQLite rows");
        return rows.map(object);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export function immediate<T>(db: Sqlite, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    if (result instanceof Promise) {
      throw new Error("SQLite mutations must be synchronous");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
