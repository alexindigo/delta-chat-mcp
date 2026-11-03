// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import {
  Registry,
  RegistryWriter,
} from "../../integrations/opencode/registry.ts";
import {
  type Subscription,
  terminalDeliveryStates,
} from "../../integrations/opencode/types.ts";
import { deadline, fixture, poll } from "../support.ts";

const owner = "http://127.0.0.1:4097/";
function row(name: string): Subscription {
  return {
    session_id: `ses_${name}`,
    relay: "test@example.invalid",
    chat_id: 42,
    directory: `/test/${name}`,
    owner_server: owner,
    alias: "fixture",
    state: "active",
    anchor_id: 10,
    recent_ids: [10],
    created_at: 1,
    updated_at: 1,
    left_at: null,
  };
}
async function setup() {
  const root = await fixture("opencode-registry");
  const path = `${root}/wake.sqlite`;
  const db = await openSqlite(path);
  const registry = new Registry(db);
  const read = await openSqlite(path, true);
  return {
    root,
    path,
    db,
    registry,
    read,
    directories: () =>
      read.all(
        "SELECT directory FROM keeper_directories WHERE owner_server=? ORDER BY directory",
        owner,
      ).map((r) => r.directory),
  };
}
function child(path: string, mode: string, name: string, count = 1) {
  const process = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      new URL(
        "../../integrations/opencode/tests/fixtures/registry-writer.ts",
        import.meta.url,
      ).pathname,
      path,
      mode,
      name,
      String(count),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const lines: string[] = [];
  const out = process.stdout.pipeThrough(new TextDecoderStream()).pipeTo(
    new WritableStream({
      write(s) {
        lines.push(s);
      },
    }),
  );
  const err = new Response(process.stderr).text();
  const saw = (text: string) =>
    poll(() => lines.join("").includes(text), 15_000);
  return {
    saw,
    async end(kill = false) {
      if (kill) process.kill("SIGKILL");
      await process.stdin.close();
      const status = await deadline(process.status, 15_000);
      await out;
      const stderr = await err;
      if (!kill) assertEquals(status.code, 0, stderr);
    },
  };
}

Deno.test("A-J2-1 committed view follows both commit orders and a blocked BEGIN IMMEDIATE", async () => {
  for (const order of [["A", "B"], ["B", "A"]]) {
    const s = await setup();
    const otherWriter = new Registry(await openSqlite(s.path));
    try {
      assertEquals(s.directories(), []);
      for (let i = 0; i < 2; i++) {
        const writer = order[i] === "A" ? s.registry : otherWriter;
        writer.write((tx) => tx.putSubscription(row(order[i])));
        assertEquals(
          s.directories(),
          order.slice(0, i + 1).sort().map((n) => `/test/${n}`),
        );
      }
    } finally {
      otherWriter.close();
      s.read.close();
      s.registry.close();
    }
  }
  const s = await setup();
  let writer: ReturnType<typeof child> | undefined;
  try {
    s.db.exec("BEGIN IMMEDIATE");
    // This write is deliberately uncommitted to characterize the read boundary.
    const tx = new RegistryWriter(s.db);
    tx.putSubscription(row("A"));
    tx.finish();
    writer = child(s.path, "pre", "B");
    await writer.saw("START");
    assertEquals(s.directories(), []);
    s.db.exec("COMMIT");
    await writer.saw("PRE");
    assertEquals(s.directories(), ["/test/A"]);
    await writer.end();
    writer = undefined;
    assertEquals(s.directories(), ["/test/A", "/test/B0"]);
    console.log(
      JSON.stringify({
        gate: "A-J2-1",
        committedOrders: ["A,B", "B,A", "A-begin,B-blocked,A-commit,B-commit"],
      }),
    );
  } finally {
    if (writer) await writer.end(true);
    s.read.close();
    s.registry.close();
  }
});

Deno.test("A-J2-2 SIGKILL before and after COMMIT preserves exactly the committed set", async () => {
  const s = await setup();
  let writer: ReturnType<typeof child> | undefined;
  try {
    writer = child(s.path, "pre", "C");
    await writer.saw("PRE");
    assertEquals(s.directories(), []);
    await writer.end(true);
    writer = undefined;
    assertEquals(s.directories(), []);
    s.registry.write((tx) => tx.putSubscription(row("next")));
    writer = child(s.path, "post", "C");
    await writer.saw("POST");
    await writer.end(true);
    writer = undefined;
    assertEquals(s.directories(), ["/test/C0", "/test/next"]);
    console.log(
      JSON.stringify({
        gate: "A-J2-2",
        preCommitExcluded: true,
        nextWriterSucceeded: true,
        postCommitRetained: true,
      }),
    );
  } finally {
    if (writer) await writer.end(true);
    s.read.close();
    s.registry.close();
  }
});

Deno.test("A-J2-3 two concurrent child writers retain all 100 distinct directories", async () => {
  const s = await setup();
  const writers = [
    child(s.path, "normal", "A", 50),
    child(s.path, "normal", "B", 50),
  ];
  try {
    await Promise.all(writers.map((w) => w.end()));
    const expected = ["A", "B"].flatMap((p) =>
      Array.from({ length: 50 }, (_, i) => `/test/${p}${i}`)
    ).sort();
    assertEquals(s.directories(), expected);
    console.log(
      JSON.stringify({
        gate: "A-J2-3",
        concurrentWriters: 2,
        committedDirectories: s.directories().length,
        busyErrors: 0,
      }),
    );
  } finally {
    s.read.close();
    s.registry.close();
  }
});

Deno.test("A-J2-4 read-only snapshot rejects writes and permits concurrent writer COMMIT", async () => {
  const s = await setup();
  try {
    s.read.exec("BEGIN");
    assertEquals(s.directories(), []);
    const writeError = assertThrows(
      () => s.read.run("UPDATE schema_version SET version=1 WHERE version=1"),
      Error,
    );
    assert(/readonly|read-only/i.test(writeError.message));
    const begin = Date.now();
    s.registry.write((tx) => tx.putSubscription(row("A")));
    assert(Date.now() - begin < 10_000);
    assertEquals(s.directories(), [], "Reader retains its old snapshot");
    s.read.exec("COMMIT");
    assertEquals(s.directories(), ["/test/A"]);
    console.log(
      JSON.stringify({
        gate: "A-J2-4",
        writeRejected: true,
        writerCommittedDuringRead: true,
        freshReadSeesCommit: true,
      }),
    );
  } finally {
    s.read.close();
    s.registry.close();
  }
});

Deno.test("keeper view retains nonterminal deliveries after leave and excludes every declared terminal outcome", async () => {
  const s = await setup();
  try {
    s.registry.write((tx) =>
      tx.putSubscription({ ...row("A"), state: "left", left_at: 1 })
    );
    assertEquals(s.directories(), []);
    for (const state of terminalDeliveryStates) {
      const id = crypto.randomUUID();
      const d = {
        id,
        session_id: "ses_A",
        relay: "test@example.invalid",
        chat_id: 42,
        from_anchor: 10,
        message_ids: [11],
        state: "open" as const,
        user_message_id: null,
        attempts: 0,
        continuations: 0,
        model_sent_ids: [],
        mirror_message_ids: [],
        superseding_message_id: null,
        reason: null,
        created_at: 1,
        updated_at: 1,
        completed_at: null,
      };
      s.registry.write((tx) => tx.putDelivery(d));
      assertEquals(s.directories(), ["/test/A"]);
      s.registry.write((tx) => {
        if (["source_deleted", "cancelled"].includes(state)) {
          tx.transition(id, "open", state, 2);
          return;
        }
        tx.transition(id, "open", "submitting", 1);
        tx.transition(id, "submitting", "admitted", 1);
        if (["mirrored", "mirror_uncertain", "mirror_failed"].includes(state)) {
          tx.transition(id, "admitted", "mirroring", 1);
          tx.transition(id, "mirroring", state, 2);
        } else tx.transition(id, "admitted", state, 2);
      });
      assertEquals(s.directories(), [], state);
    }
    for (
      const state of [
        "paused",
        "blocked_discontinuity",
        "unroutable",
        "active",
      ] as const
    ) {
      s.registry.write((tx) => tx.putSubscription({ ...row("A"), state }));
      assertEquals(s.directories(), ["/test/A"]);
    }
  } finally {
    s.read.close();
    s.registry.close();
  }
});
