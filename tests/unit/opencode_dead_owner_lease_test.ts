// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import type {
  OwnerProcess,
  OwnerWitness,
} from "../../integrations/opencode/owner-witness.ts";

const owner = "http://localhost:4096/";
const old: OwnerWitness = {
  v: 1,
  bootID: "a".repeat(64),
  pidNS: "1:1",
  timeNS: "1:2",
  userNS: "1:3",
  uid: 1000,
  pid: 123,
  start: "456",
};
const next: OwnerWitness = { ...old, pid: 124, start: "789" };
const process = (
  w: OwnerWitness,
  fate: "alive" | "dead" | "unknown" = "alive",
): OwnerProcess => ({ capture: () => ({ ...w }), fate: () => fate });
async function world() {
  const db = await openSqlite(":memory:"), registry = new Registry(db);
  const add = (session = "session") =>
    registry.write((tx) =>
      tx.subscribe({
        session_id: session,
        relay: "relay@example.invalid",
        chat_id: 42,
        directory: "/A",
        owner_server: owner,
        alias: "relay",
        message_id: 90,
      }, 1)
    );
  add();
  const acquire = (
    holder: string,
    port?: OwnerProcess,
    session = "session",
    now = 100,
  ) =>
    registry.write((tx) =>
      tx.tryAcquireLease(session, holder, owner, now, 90_000, port)
    );
  return { db, registry, add, acquire };
}
Deno.test("dead exact witnessed holder is taken over atomically; live/unknown holder keeps original deadline and CAS winner", async () => {
  const f = await world();
  try {
    assertEquals(f.acquire("old", process(old)), { acquired: true });
    for (const fate of ["alive", "unknown"] as const) {
      assertEquals(f.acquire("new", process(next, fate)), {
        acquired: false,
        retryAt: 90100,
      });
    }
    assertEquals(f.acquire("new", process(next, "dead")), { acquired: true });
    assertEquals(f.db.all("SELECT holder FROM lease_witness"), [{
      holder: "new",
    }]);
    assertEquals(f.acquire("racer", process({ ...next, pid: 125 }, "alive")), {
      acquired: false,
      retryAt: 90100,
    });
    assertEquals(f.db.get("SELECT holder FROM lease")?.holder, "new");
    assertEquals(f.db.all("PRAGMA table_info(lease)").length, 4);
    assertEquals(f.db.get("SELECT version FROM schema_version")?.version, 1);
    assertEquals(f.registry.directories(owner), ["/A"]);
  } finally {
    f.registry.close();
  }
});
Deno.test("scope/owner/witness/fate failures and legacy no-witness rows retain the unexpired lease", async () => {
  const f = await world();
  try {
    f.acquire("old", process(old));
    let probes = 0;
    for (const key of ["bootID", "pidNS", "timeNS", "userNS", "uid"] as const) {
      const changed = {
        ...next,
        [key]: key === "uid" ? 1001 : key === "bootID" ? "b".repeat(64) : "9:9",
      };
      assertEquals(
        f.acquire("new", {
          capture: () => changed as OwnerWitness,
          fate: () => {
            probes++;
            return "dead";
          },
        }),
        { acquired: false, retryAt: 90100 },
      );
    }
    assertEquals(probes, 0);
    assertEquals(
      f.registry.write((tx) =>
        tx.tryAcquireLease("session", "new", "http://other/", 100, 90000, {
          capture() {
            throw new Error("must not capture");
          },
          fate() {
            throw new Error("must not probe");
          },
        })
      ),
      { acquired: false, retryAt: null },
    );
    assertEquals(
      f.acquire("new", {
        capture: () => next,
        fate() {
          throw new Error("unknown");
        },
      }),
      { acquired: false, retryAt: 90100 },
    );
    assertEquals(f.acquire("new"), { acquired: false, retryAt: 90100 });
    f.db.run("UPDATE lease_witness SET boot_id='malformed'");
    assertEquals(f.acquire("new", process(next, "dead")), {
      acquired: false,
      retryAt: 90100,
    });
    f.db.run("DELETE FROM lease_witness");
    assertEquals(f.acquire("new", process(next, "dead")), {
      acquired: false,
      retryAt: 90100,
    });
    assertEquals(f.acquire("new", undefined, "session", 90100), {
      acquired: true,
    });
    assertEquals(
      f.registry.write((tx) => tx.acquireLease("session", "new", owner, 90101)),
      true,
    );
  } finally {
    f.registry.close();
  }
});
Deno.test("fresh capture occurs inside writer; unavailable current profile never renews stale witness; conflicts roll back", async () => {
  const f = await world();
  try {
    f.acquire("old", process(old));
    const lease = f.db.all("SELECT * FROM lease"),
      witness = f.db.all("SELECT * FROM lease_witness");
    assertEquals(
      f.acquire("old", { capture: () => undefined, fate: () => "dead" }),
      { acquired: false, retryAt: 90100 },
    );
    assertEquals(f.db.all("SELECT * FROM lease"), lease);
    assertEquals(f.db.all("SELECT * FROM lease_witness"), witness);
    assertThrows(
      () => f.acquire("old", process({ ...old, start: "999" })),
      Error,
      "Lease witness conflict",
    );
    assertEquals(f.db.all("SELECT * FROM lease"), lease);
    assertEquals(f.db.all("SELECT * FROM lease_witness"), witness);
    const original = f.db.exec;
    let transaction = false;
    f.db.exec = (sql) => {
      original(sql);
      if (sql === "BEGIN IMMEDIATE") transaction = true;
      if (sql === "COMMIT" || sql === "ROLLBACK") transaction = false;
    };
    assertEquals(
      f.acquire("new", {
        capture() {
          assertEquals(transaction, true);
          return next;
        },
        fate(w) {
          assertEquals(w, old);
          return "dead";
        },
      }),
      { acquired: true },
    );
  } finally {
    f.registry.close();
  }
});

Deno.test("exact witness comparison detects a probe-side mutation and rolls back both lease and proof", async () => {
  const f = await world();
  try {
    f.acquire("old", process(old));
    const before = [
      f.db.all("SELECT * FROM lease"),
      f.db.all("SELECT * FROM lease_witness"),
    ];
    assertThrows(
      () =>
        f.acquire("new", {
          capture: () => next,
          fate() {
            f.db.run("UPDATE lease_witness SET start='999' WHERE holder='old'");
            return "dead";
          },
        }),
      Error,
      "Lease witness changed during probe",
    );
    assertEquals([
      f.db.all("SELECT * FROM lease"),
      f.db.all("SELECT * FROM lease_witness"),
    ], before);
    f.db.run("UPDATE lease SET owner_server='http://foreign/'");
    let probes = 0;
    assertEquals(
      f.acquire("new", {
        capture: () => next,
        fate() {
          probes++;
          return "dead";
        },
      }),
      { acquired: false, retryAt: 90100 },
    );
    assertEquals(probes, 0);
    f.add("unwitnessed");
    assertEquals(
      f.acquire("unwitnessed", {
        capture: () => undefined,
        fate: () => "dead",
      }, "unwitnessed"),
      { acquired: true },
    );
    assertEquals(
      f.db.get("SELECT * FROM lease_witness WHERE holder='unwitnessed'"),
      undefined,
    );
  } finally {
    f.registry.close();
  }
});
Deno.test("shared holder witness survives referenced session and is pruned only after final release, idle fence or owner transfer", async () => {
  const f = await world();
  try {
    f.add("second");
    f.acquire("old", process(old));
    f.acquire("old", process(old), "second");
    f.registry.write((tx) => tx.releaseLease("session", "old"));
    assertEquals(f.db.all("SELECT holder FROM lease_witness"), [{
      holder: "old",
    }]);
    assertEquals(f.registry.write((tx) => tx.releaseIdleLeases("old")), [
      "second",
    ]);
    assertEquals(f.db.all("SELECT * FROM lease_witness"), []);
    f.acquire("old", process(old));
    f.registry.write((tx) =>
      tx.subscribe({
        session_id: "session",
        relay: "relay@example.invalid",
        chat_id: 42,
        directory: "/B",
        owner_server: "http://other/",
        alias: "relay",
        message_id: 91,
      }, 200)
    );
    assertEquals(f.db.all("SELECT * FROM lease_witness"), []);
  } finally {
    f.registry.close();
  }
});
Deno.test("dead-owner takeover changes no accepted/uncertain stable IDs, ordinals, native evidence or submission state", async () => {
  for (
    const state of [
      "submitting",
      "submitted",
      "admission_failed",
      "admitted",
    ] as const
  ) {
    const f = await world();
    try {
      const sub = f.registry.subscriptions()[0];
      f.registry.write((tx) => tx.recordBatch(sub, 90, [5], [5], 2));
      const d = f.registry.deliveries()[0],
        s = f.registry.write((tx) =>
          tx.allocateSubmission(d.id, crypto.randomUUID(), 0, 3)
        );
      if (state !== "submitting") {
        f.registry.write((tx) =>
          tx.updateSubmission({ ...s, state, updated_at: 4 })
        );
      }
      f.registry.write((tx) => tx.observeNativeID(d.id, 0, 5));
      f.acquire("old", process(old));
      const before = [
        f.db.all("SELECT * FROM delivery"),
        f.db.all("SELECT * FROM submission"),
        f.db.all("SELECT * FROM native_execution"),
      ];
      assertEquals(f.acquire("new", process(next, "dead")), { acquired: true });
      assertEquals([
        f.db.all("SELECT * FROM delivery"),
        f.db.all("SELECT * FROM submission"),
        f.db.all("SELECT * FROM native_execution"),
      ], before);
    } finally {
      f.registry.close();
    }
  }
});
