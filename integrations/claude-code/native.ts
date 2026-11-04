// SPDX-License-Identifier: LGPL-3.0-only
import { readFileSync } from "node:fs";
import { ppid } from "node:process";
import { createHash } from "node:crypto";
import type { Sqlite } from "../opencode/sqlite.ts";
import { object } from "../opencode/types.ts";
import { type Delivery, Store } from "../conversations/store.ts";
import type { Coordinator } from "../conversations/coordinator.ts";

/** SessionStart and the directly spawned MCP worker observe the same native
 * parent. PID reuse is fenced by Linux boot and start tokens, not by a timeout. */
export function nativeOwner(pid = ppid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (!/^\d+$/.test(start)) {
    throw new Error("Native process identity unavailable");
  }
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9-]{36}$/i.test(boot)) {
    throw new Error("Native boot identity unavailable");
  }
  return createHash("sha256").update(JSON.stringify([pid, start, boot])).digest(
    "hex",
  );
}
export function nativeSchema(db: Sqlite) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS channel_native(owner TEXT PRIMARY KEY,session TEXT NOT NULL,turn TEXT,busy INTEGER NOT NULL,ended INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS channel_native_event(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,session TEXT NOT NULL,
      event TEXT NOT NULL,input TEXT,delivery TEXT,nonce TEXT,turn TEXT);
    CREATE TABLE IF NOT EXISTS channel_native_call(owner TEXT NOT NULL,call TEXT NOT NULL,session TEXT NOT NULL,turn TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(owner,call));`,
  );
}
function string(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Native hook payloads are reduced to references at the input boundary. Prompt
 * and last_assistant_message bodies never enter this integration's database. */
export function hookEvent(store: Store, owner: string, value: unknown) {
  const input = object(value);
  if (input.agent_id !== undefined) return; // Main native loop owns this channel.
  const session = string(input, "session_id");
  const event = string(input, "hook_event_name");
  const turn = string(input, "prompt_id");
  if (!session || !event) throw new Error("Native hook identity missing");
  const db = store.db;
  if (event === "SessionStart") {
    const previous = db.get(
      "SELECT session FROM channel_native WHERE owner=?",
      owner,
    );
    if (previous && previous.session !== session) {
      throw new Error(
        "Native session changed inside an existing channel owner",
      );
    }
    db.run(
      "INSERT OR IGNORE INTO channel_native(owner,session,busy) VALUES(?,?,0)",
      owner,
      session,
    );
  }
  const bound = db.get(
    "SELECT session FROM channel_native WHERE owner=?",
    owner,
  );
  if (bound?.session !== session) throw new Error("Unbound native hook");
  if (event === "UserPromptSubmit" && turn) {
    db.run(
      "UPDATE channel_native SET turn=?,busy=1 WHERE owner=?",
      turn,
      owner,
    );
    const prompt = string(input, "prompt") ?? "";
    const opening = /^<channel\s+[^>]*>/.exec(prompt)?.[0];
    const attribute = (name: string) =>
      opening
        ? new RegExp(`\\b${name}="([a-f0-9-]{36})"`).exec(opening)?.[1]
        : undefined;
    const delivery = attribute("delivery_id");
    // Hooks are native-process observations, not a receiver owner. The random
    // prepared nonce, exact native session and input reference fence this lookup.
    const row = delivery
      ? db.get(
        "SELECT * FROM channel_delivery WHERE id=? AND session=?",
        delivery,
        session,
      ) as unknown as Delivery | undefined
      : undefined;
    const matching = row?.session === session &&
      row.input === attribute("input_id") && row.nonce === attribute("nonce");
    db.run(
      "INSERT INTO channel_native_event(owner,session,event,input,delivery,nonce,turn) VALUES(?,?,'input',?,?,?,?)",
      owner,
      session,
      matching ? row.input : turn,
      matching ? row.id : null,
      matching ? row.nonce : null,
      turn,
    );
  } else if (event === "PreToolUse" && turn) {
    const call = string(input, "tool_use_id");
    if (call) {
      db.run(
        "INSERT OR REPLACE INTO channel_native_call VALUES(?,?,?,?,?)",
        owner,
        call,
        session,
        turn,
        Date.now(),
      );
    }
  } else if ((event === "Stop" || event === "StopFailure") && turn) {
    db.run(
      "UPDATE channel_native SET busy=0 WHERE owner=? AND turn=?",
      owner,
      turn,
    );
    db.run(
      "INSERT INTO channel_native_event(owner,session,event,turn) VALUES(?,?,?,?)",
      owner,
      session,
      event === "Stop" ? "finished" : "failed",
      turn,
    );
  } else if (event === "SessionEnd") {
    db.run("UPDATE channel_native SET ended=1 WHERE owner=?", owner);
  }
}

export class NativeState {
  constructor(readonly store: Store, readonly owner: string) {}
  session() {
    const row = this.store.db.get(
      "SELECT * FROM channel_native WHERE owner=?",
      this.owner,
    );
    return row && row.ended === 0 ? String(row.session) : undefined;
  }
  ready(session: string) {
    const row = this.store.db.get(
      "SELECT * FROM channel_native WHERE owner=?",
      this.owner,
    );
    return row?.session === session && row.busy === 0 && row.ended === 0;
  }
  turn(session: string, call: string) {
    const row = this.store.db.get(
      "SELECT turn FROM channel_native_call WHERE owner=? AND session=? AND call=?",
      this.owner,
      session,
      call,
    );
    return row ? String(row.turn) : undefined;
  }
  drain(coordinator: Pick<Coordinator, "input" | "finished">) {
    const rows = this.store.db.all(
      "SELECT * FROM channel_native_event WHERE owner=? ORDER BY seq",
      this.owner,
    );
    for (const row of rows) {
      if (row.event === "input") {
        const delivery = row.delivery
          ? this.store.delivery(String(row.delivery))
          : undefined;
        coordinator.input(
          String(row.session),
          String(row.input),
          delivery?.nonce === row.nonce ? delivery?.id : undefined,
          String(row.turn),
        );
      } else {coordinator.finished(
          String(row.session),
          String(row.turn),
          row.event === "finished" ? "finished" : "failed",
        );}
      this.store.db.run(
        "DELETE FROM channel_native_event WHERE seq=? AND owner=?",
        Number(row.seq),
        this.owner,
      );
    }
    this.store.db.run(
      "DELETE FROM channel_native_call WHERE updated<?",
      Date.now() - 7 * 86400000,
    );
  }
}
