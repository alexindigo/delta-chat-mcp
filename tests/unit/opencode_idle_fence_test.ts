// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { Dispatcher } from "../../integrations/opencode/dispatcher.ts";
import { OpenCode } from "../../integrations/opencode/opencode.ts";
import {
  Registry,
  type RegistryWriter,
} from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";

async function idleWorld() {
  const db = await openSqlite(":memory:");
  const registry = new Registry(db);
  const add = (session: string, chat = 42) =>
    registry.write((tx) => {
      const sub = tx.subscribe({
        session_id: session,
        relay: "relay@example.invalid",
        chat_id: chat,
        directory: "/A",
        owner_server: "http://localhost:4097/",
        alias: "relay",
        message_id: 90,
      }, 1);
      tx.recordBatch(sub, 90, [5], [5], 2);
      return registry.deliveries(session).find((d) => d.chat_id === chat)!;
    });
  const lease = (session: string, holder = "old") =>
    registry.write((tx) =>
      tx.tryAcquireLease(session, holder, "http://localhost:4097/", 100)
    );
  return { db, registry, add, lease };
}

Deno.test("idle fence registry classifies every nonterminal row across rooms and owners conservatively", async () => {
  const f = await idleWorld();
  const cases = [
    "open",
    "empty",
    "terminal",
    "admitted-answer",
    "mirroring-answer",
    "submitting",
    "submitted",
    "admission_failed",
    "failed-submission",
    "admitted-unanswered",
    "open-prior",
    "prior-epoch",
    "missing-submission",
    "wrong-ordinal",
    "older-answer",
    "unknown",
    "other-room",
    "other-owner",
    "mirroring-unanswered",
    "newer-submission",
  ];
  const safe = cases.slice(0, 5);
  try {
    // Fixture-only inconsistent rows exercise the conservative SQL boundary.
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    for (const name of cases) {
      const d = f.add(name);
      assertEquals(f.lease(name), { acquired: true });
      if (name === "empty") f.db.run("DELETE FROM delivery WHERE id=?", d.id);
      else if (name === "terminal") {
        f.registry.write((tx) =>
          tx.transition(d.id, "open", "cancelled", 3, "left")
        );
      } else if (["other-room", "other-owner"].includes(name)) {
        const other = f.add(name, 43);
        f.registry.write((tx) =>
          tx.allocateSubmission(other.id, crypto.randomUUID(), 0, 3)
        );
        if (name === "other-owner") {
          f.db.run(
            "UPDATE subscription SET owner_server='other',directory='/B',state='paused' WHERE session_id=? AND chat_id=43",
            name,
          );
        }
      } else if (name === "unknown") {
        f.db.run("UPDATE delivery SET state='unknown' WHERE id=?", d.id);
      } else if (name === "missing-submission") {
        f.db.run("UPDATE delivery SET state='admitted' WHERE id=?", d.id);
      } else if (name !== "open") {
        const sub = f.registry.write((tx) =>
          tx.allocateSubmission(d.id, crypto.randomUUID(), 0, 3)
        );
        if (["submitted", "admission_failed"].includes(name)) {
          f.registry.write((tx) =>
            tx.updateSubmission({
              ...sub,
              state: name as "submitted" | "admission_failed",
              updated_at: 4,
            })
          );
        } else if (name === "failed-submission") {
          f.db.run(
            "UPDATE submission SET state='failed' WHERE delivery_id=?",
            d.id,
          );
          f.db.run("UPDATE delivery SET state='admitted' WHERE id=?", d.id);
        } else if (name === "open-prior") {
          f.db.run("UPDATE delivery SET state='open' WHERE id=?", d.id);
        } else if (name !== "submitting" && name !== "prior-epoch") {
          f.registry.write((tx) =>
            tx.updateSubmission({ ...sub, state: "admitted", updated_at: 4 })
          );
          if (!["admitted-unanswered", "mirroring-unanswered"].includes(name)) {
            f.registry.write((tx) =>
              tx.recordAnswer(d.id, 0, {
                messageID: "msg_answer",
                partIDs: ["prt_answer"],
              }, 5)
            );
          }
          if (name.startsWith("mirroring")) {
            f.db.run("UPDATE delivery SET state='mirroring' WHERE id=?", d.id);
          }
          if (name === "wrong-ordinal") {
            f.db.run("UPDATE delivery SET continuations=1 WHERE id=?", d.id);
          }
          if (["older-answer", "newer-submission"].includes(name)) {
            const next = f.registry.write((tx) =>
              tx.allocateSubmission(d.id, crypto.randomUUID(), 1, 6)
            );
            f.registry.write((tx) =>
              tx.updateSubmission({ ...next, state: "admitted", updated_at: 7 })
            );
            if (name === "newer-submission") {
              f.db.run("UPDATE delivery SET continuations=0 WHERE id=?", d.id);
            }
          }
        }
      }
    }
    const foreign = f.add("foreign");
    assertEquals(f.lease(foreign.session_id, "foreign-holder"), {
      acquired: true,
    });
    const before = f.db.all("SELECT * FROM delivery ORDER BY id");
    const leases = f.db.all("SELECT * FROM lease ORDER BY session_id");
    assertEquals(
      f.registry.write((tx) => tx.releaseIdleLeases("old")).sort(),
      safe.sort(),
    );
    assertEquals(
      f.db.all("SELECT * FROM delivery ORDER BY id"),
      before,
      "no delivery mutation",
    );
    assertEquals(
      f.db.all("SELECT * FROM lease ORDER BY session_id"),
      leases.filter((row) => !safe.includes(String(row.session_id))),
      "all unsafe and foreign leases retain exact holder/expiry, including owner-denied sessions",
    );
    for (const name of cases) {
      assertEquals(
        f.lease(name, "successor"),
        safe.includes(name) ? { acquired: true } : {
          acquired: false,
          retryAt: name === "other-owner" ? null : 90_100,
        },
        name,
      );
    }
    assertEquals(f.lease("foreign", "successor"), {
      acquired: false,
      retryAt: 90_100,
    });
    assertEquals(f.registry.write((tx) => tx.releaseIdleLeases("old")), []);
    let expired!: RegistryWriter;
    f.registry.write((tx) => {
      expired = tx;
    });
    assertThrows(
      () => expired.releaseIdleLeases("old"),
      Error,
      "Expired registry transaction",
    );
  } finally {
    f.registry.close();
  }
});

Deno.test("idle fence fails closed on unavailable registry, read and transaction failures and remains idempotent", async () => {
  for (const failure of ["unavailable", "read", "commit"] as const) {
    const f = await idleWorld();
    f.add("session");
    f.lease("session");
    const all = f.db.all, exec = f.db.exec;
    let reads = 0;
    const runtime = new Dispatcher({
      registry() {
        reads++;
        if (failure === "unavailable") throw new Error("unavailable");
        return f.registry;
      },
      opencode: new OpenCode({}),
      relays: new Map(),
      owner: "http://localhost:4097/",
      directory: "/A",
      holder: "old",
      epoch: "epoch",
      signal: new AbortController().signal,
    });
    try {
      if (failure === "read") {
        f.db.all = () => {
          throw new Error("read failed");
        };
      }
      if (failure === "commit") {
        f.db.exec = (sql) => {
          if (sql === "COMMIT") throw new Error("commit failed");
          exec.call(f.db, sql);
        };
      }
      runtime.fence();
      const count = reads;
      runtime.fence();
      assertEquals(reads, count, "a repeat does not reattempt a failed fence");
    } finally {
      f.db.all = all;
      f.db.exec = exec;
    }
    try {
      assertEquals(f.lease("session", "successor"), {
        acquired: false,
        retryAt: 90_100,
      }, failure);
      await runtime.close();
      await runtime.close();
    } finally {
      f.registry.close();
    }
  }
});
