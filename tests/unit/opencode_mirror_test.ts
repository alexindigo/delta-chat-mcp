// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  answerText,
  classifyCompletion,
} from "../../integrations/opencode/completion.ts";
import { Mirror } from "../../integrations/opencode/mirror.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { RelayFailure } from "../../integrations/opencode/relay.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import type { NativeMessage } from "../../integrations/opencode/types.ts";
import { deadline, fixture, poll } from "../support.ts";

async function world() {
  const root = await fixture("j5-mirror");
  const path = `${root}/wake.sqlite`;
  const registry = new Registry(await openSqlite(path));
  const epoch = crypto.randomUUID();
  const s = registry.write((tx) =>
    tx.subscribe({
      session_id: "session",
      relay: "relay@example.invalid",
      chat_id: 42,
      directory: "/A",
      owner_server: "http://localhost:4097/",
      alias: "relay",
      message_id: 1,
    }, 1)
  );
  registry.write((tx) => tx.recordBatch(s, 1, [2], [2], 2));
  const d = registry.deliveries()[0];
  const submission = registry.write((tx) =>
    tx.allocateSubmission(d.id, epoch, 0, 3)
  );
  registry.write((tx) =>
    tx.updateSubmission({ ...submission, state: "admitted", updated_at: 4 })
  );
  const wake: NativeMessage = {
    info: { id: submission.message_id, role: "user", time: { created: 3 } },
    parts: [{
      id: submission.part_id,
      type: "text",
      metadata: {
        deltaChatWake: {
          v: 1,
          deliveryId: d.id,
          relay: d.relay,
          chatId: d.chat_id,
        },
      },
    }],
  };
  const final: NativeMessage = {
    info: {
      id: "msg_final",
      sessionID: "session",
      role: "assistant",
      parentID: wake.info.id,
      finish: "stop",
      time: { created: 5, completed: 6 },
    },
    parts: [{
      id: "prt_answer",
      type: "text",
      text: "Exact answer\n\nα & < >",
    }],
  };
  registry.write((tx) =>
    tx.recordAnswer(d.id, 0, {
      messageID: final.info.id,
      partIDs: ["prt_answer"],
    }, 7)
  );
  let rows = [wake, final];
  let enabled = true, identity = d.relay, calls = 0;
  const received: { chat_id: number; text: string }[] = [];
  const notices: string[] = [];
  let send: (
    chat: number,
    text: string,
    signal?: AbortSignal,
  ) => Promise<{ message_id: number; chat_id: number; state: string }> = (
    chat,
    text,
  ) => {
    received.push({ chat_id: chat, text });
    return Promise.resolve({ message_id: 100, chat_id: chat, state: "sent" });
  };
  const abort = new AbortController();
  const ports = {
    registry: () => registry,
    opencode: {
      message: () => Promise.resolve(final),
      messages: () => Promise.resolve(rows),
    },
    relays: new Map([["relay", {
      health: { state: "connected" as const, retryAt: 0 },
      refreshNativeState: () => Promise.resolve(enabled),
      call: (name: string) =>
        Promise.resolve(
          name === "status" ? { address: identity } : { chats: [{ id: 42 }] },
        ),
      send: (chat: number, text: string, signal?: AbortSignal) => {
        calls++;
        assertEquals(
          registry.deliveries()[0].state,
          "mirroring",
          "durable transition BEFORE send",
        );
        return send(chat, text, signal);
      },
    }]]),
    owner: s.owner_server,
    directory: s.directory,
    epoch,
    signal: abort.signal,
    notify: (message: string) => {
      notices.push(message);
      return Promise.resolve();
    },
  };
  const mirror = new Mirror(ports);
  const state = () => registry.deliveries()[0].state;
  return {
    root,
    path,
    registry,
    ports,
    mirror,
    d,
    s,
    submission,
    wake,
    final,
    received,
    notices,
    state,
    calls: () => calls,
    setSend: (value: typeof send) => {
      send = value;
    },
    rows: (value: NativeMessage[]) => {
      rows = value;
    },
    enable: (value: boolean) => {
      enabled = value;
    },
    identity: (value: string) => {
      identity = value;
    },
    async settle() {
      await poll(() => !["admitted", "mirroring"].includes(state()), 5000);
    },
    async close() {
      abort.abort();
      await mirror.close();
      registry.close();
    },
  };
}

Deno.test("J5 repeated callbacks and simultaneous plugin connections claim one durable post", async () => {
  const w = await world();
  const secondDB = new Registry(await openSqlite(w.path));
  const second = new Mirror({ ...w.ports, registry: () => secondDB });
  try {
    await Promise.all(
      Array.from(
        { length: 20 },
        (_, i) => (i % 2 ? second : w.mirror).ready(w.d),
      ),
    );
    await w.settle();
    assertEquals(w.calls(), 1);
    assertEquals(w.state(), "mirrored");
    assertEquals(w.received, [{ chat_id: 42, text: w.final.parts[0].text! }]);
    second.all();
    w.mirror.all();
    await second.close();
    assertEquals(w.calls(), 1);
  } finally {
    await second.close();
    secondDB.close();
    await w.close();
  }
});

Deno.test("J5 orphaned/legacy mirroring crash claims are uncertain after reinit, never resent", async () => {
  for (const legacy of [false, true]) {
    const w = await world();
    try {
      if (legacy) {
        w.registry.write((tx) =>
          tx.transition(w.d.id, "admitted", "mirroring", 8)
        );
      } else {w.registry.write((tx) =>
          tx.claimMirror(
            w.d.id,
            w.s,
            crypto.randomUUID(),
            crypto.randomUUID(),
            8,
          )
        );}
      w.mirror.all();
      await w.settle();
      assertEquals(w.state(), "mirror_uncertain");
      assertEquals(w.calls(), 0);
      assertEquals(w.registry.execution(w.d.id, 0)?.answerID, "msg_final");
      assertEquals(w.notices.length, 1);
    } finally {
      await w.close();
    }
  }
});

Deno.test("J5 every ambiguous post-dispatch failure is terminal uncertain with native intent retained", async () => {
  for (
    const failure of [
      new RelayFailure("uncertain", false),
      new Error("timeout/lost response"),
      new RelayFailure("uncertain", false, "request_failed", "application"),
    ]
  ) {
    const w = await world();
    try {
      w.setSend(() => Promise.reject(failure));
      await w.mirror.ready(w.d);
      await w.settle();
      w.mirror.all();
      await w.mirror.close();
      assertEquals(w.state(), "mirror_uncertain");
      assertEquals(w.calls(), 1);
      assertEquals(w.registry.execution(w.d.id, 0)?.partIDs, ["prt_answer"]);
    } finally {
      await w.close();
    }
  }
});

Deno.test("J5 typed proven no-dispatch retries are bounded3 and durable across consumers", async () => {
  const w = await world();
  try {
    w.setSend(() => Promise.reject(new RelayFailure("pre_dispatch", true)));
    await w.mirror.ready(w.d);
    await poll(() => w.calls() === 1 && w.state() === "admitted");
    assertEquals(w.registry.mirrorProgress(w.d.id)?.attempts, 1);
    // Advance only the deterministic persisted retry clock, not transport facts.
    for (let attempt = 2; attempt <= 3; attempt++) {
      const p = w.registry.mirrorProgress(w.d.id)!;
      const db = await openSqlite(w.path);
      try {
        db.run(
          "UPDATE mirror_progress SET retry_at=0 WHERE delivery_id=?",
          w.d.id,
        );
      } finally {
        db.close();
      }
      assertEquals(p.attempts, attempt - 1);
      await w.mirror.ready(w.d);
      await poll(() =>
        w.calls() === attempt &&
        w.state() === (attempt < 3 ? "admitted" : "mirror_failed")
      );
    }
    assertEquals(w.calls(), 3);
    assertEquals(w.registry.mirrorProgress(w.d.id)?.attempts, 3);
  } finally {
    await w.close();
  }
});

Deno.test("J5 operator pause before send is not uncertainty or a consumed retry", async () => {
  const w = await world();
  try {
    w.setSend(() =>
      Promise.reject(new RelayFailure("paused", false, undefined, "guard"))
    );
    await w.mirror.ready(w.d);
    await poll(() => w.calls() === 1 && w.state() === "admitted");
    assertEquals(w.registry.mirrorProgress(w.d.id)?.attempts, 0);
    assertEquals(w.notices, []);
  } finally {
    await w.close();
  }
});

Deno.test("J5 disable and wrong identity/alias never post, re-enable preserves intent", async () => {
  const w = await world();
  try {
    w.enable(false);
    await w.mirror.ready(w.d);
    await w.mirror.close();
    assertEquals(w.calls(), 0);
    const wrong = new Mirror(w.ports);
    w.enable(true);
    w.identity("different@example.invalid");
    await wrong.ready(w.d);
    await wrong.close();
    assertEquals(w.calls(), 0);
    const missing = new Mirror({ ...w.ports, relays: new Map() });
    await missing.ready(w.d);
    await missing.close();
    assertEquals(w.calls(), 0);
    w.identity(w.d.relay);
    const resumed = new Mirror(w.ports);
    await resumed.ready(w.d);
    await w.settle();
    await resumed.close();
    assertEquals(w.calls(), 1);
    assertEquals(w.state(), "mirrored");
  } finally {
    await w.close();
  }
});

Deno.test("J5 after-hook binds running native tool part/session/delivery/coreID despite reused callIDs", async () => {
  const w = await world();
  try {
    const tool = {
      id: "prt_tool",
      type: "tool",
      tool: "relay_send_message",
      callID: "call_fixture",
      state: { status: "running" },
    };
    const running: NativeMessage = {
      info: { ...w.final.info, id: "msg_tool", finish: "tool-calls" },
      parts: [tool],
    };
    const old: NativeMessage = {
      info: { ...w.final.info, id: "msg_old", parentID: "msg_other" },
      parts: [{ ...tool, id: "prt_old", state: { status: "completed" } }],
    };
    w.rows([old, w.wake, running, w.final]);
    const call = {
      sessionID: "session",
      callID: "call_fixture",
      tool: "relay_send_message",
      args: { chat_id: 42, text: w.final.parts[0].text },
    };
    const result = {
      structuredContent: { chat_id: 42, message_id: 91 },
      content: [],
    };
    await w.mirror.observe({ ...call, sessionID: "other" }, result);
    assertEquals(w.registry.modelSends(w.d.id), []);
    await w.mirror.observe(call, result);
    const evidence = w.registry.modelSends(w.d.id);
    assertEquals(
      evidence.map((e) => [e.messageID, e.partID, e.callID, e.coreID]),
      [["msg_tool", "prt_tool", "call_fixture", 91]],
    );
    await w.mirror.ready(w.d);
    await w.settle();
    assertEquals(w.state(), "answered_by_model");
    assertEquals(w.calls(), 0);
    assertEquals(w.registry.deliveries()[0].model_sent_ids, [91]);
  } finally {
    await w.close();
  }
});

Deno.test("J5 self-correlation uses canonical relay identity across aliases, never numeric room alone", async () => {
  for (const sameIdentity of [true, false]) {
    const w = await world();
    try {
      const relay = w.ports.relays.get("relay")!;
      w.ports.relays.set("twin", {
        ...relay,
        call: (name: string) =>
          Promise.resolve(
            name === "status"
              ? { address: sameIdentity ? w.d.relay : "other@example.invalid" }
              : { chats: [{ id: 42 }] },
          ),
      });
      const running: NativeMessage = {
        info: { ...w.final.info, id: "msg_twin", finish: "tool-calls" },
        parts: [{
          id: "prt_twin",
          type: "tool",
          tool: "twin_send_message",
          callID: "call_fixture",
          state: { status: "running" },
        }],
      };
      w.rows([w.wake, running, w.final]);
      await w.mirror.observe({
        sessionID: "session",
        callID: "call_fixture",
        tool: "twin_send_message",
        args: { chat_id: 42, text: w.final.parts[0].text },
      }, { structuredContent: { chat_id: 42, message_id: 95 }, content: [] });
      await w.mirror.ready(w.d);
      await w.settle();
      assertEquals(w.state(), sameIdentity ? "answered_by_model" : "mirrored");
      assertEquals(w.calls(), sameIdentity ? 0 : 1);
    } finally {
      await w.close();
    }
  }
});

Deno.test("J5 other-session or earlier completed identical sends never suppress required final", async () => {
  const w = await world();
  try {
    const old: NativeMessage = {
      info: { ...w.final.info, id: "msg_prior" },
      parts: [{
        id: "prt_prior",
        type: "tool",
        tool: "relay_send_message",
        callID: "call_fixture",
        state: { status: "completed" },
      }],
    };
    w.rows([w.wake, old, w.final]);
    await w.mirror.observe({
      sessionID: "session",
      callID: "call_fixture",
      tool: "relay_send_message",
      args: { chat_id: 42, text: w.final.parts[0].text },
    }, { structuredContent: { chat_id: 42, message_id: 92 }, content: [] });
    assertEquals(w.registry.modelSends(w.d.id), []);
    await w.mirror.ready(w.d);
    await w.settle();
    assertEquals(w.calls(), 1);
  } finally {
    await w.close();
  }
});

Deno.test("J5 failed sender observation cannot turn an accepted native MCP result into an error", async () => {
  const w = await world();
  const observer = new Mirror({
    ...w.ports,
    opencode: {
      ...w.ports.opencode,
      messages: () => Promise.reject(new Error("native read failed")),
    },
  });
  try {
    const result = {
      structuredContent: { chat_id: 42, message_id: 93 },
      content: [{ type: "text", text: "accepted" }],
    };
    const before = JSON.stringify(result);
    await observer.observe({
      sessionID: "session",
      callID: "call_fixture",
      tool: "relay_send_message",
      args: { chat_id: 42, text: "answer" },
    }, result);
    assertEquals(JSON.stringify(result), before);
    assertEquals(w.registry.modelSends(w.d.id), []);
  } finally {
    await observer.close();
    await w.close();
  }
});

Deno.test("J5 slow transport scheduling returns without holding native execution, abort joins consumer", async () => {
  const w = await world();
  try {
    w.setSend((_chat, _text, signal) =>
      new Promise((_, reject) => {
        signal!.addEventListener("abort", () =>
          reject(new RelayFailure("uncertain", false)), { once: true });
      })
    );
    await deadline(w.mirror.ready(w.d), 1000);
    await poll(() => w.calls() === 1);
    const second = new Mirror(w.ports);
    await second.ready(w.d);
    await second.close();
    assertEquals(w.state(), "mirroring");
    assertEquals(w.calls(), 1);
    await w.close();
    assertEquals(w.notices, []);
  } finally {
    /* closed registry inspected only before close */
  }
});

Deno.test("J5 exact extraction omits reasoning/synthetic/ignored/summary without trimming wording", async () => {
  const w = await world();
  try {
    const row: NativeMessage = {
      ...w.final,
      parts: [
        { id: "r", type: "reasoning", text: "private reasoning" },
        { id: "s", type: "text", synthetic: true, text: "internal" },
        { id: "i", type: "text", ignored: true, text: "ignored" },
        { id: "a", type: "text", text: "  first\nline " },
        { id: "b", type: "text", text: "second\n\nlast" },
      ],
    };
    assertEquals(
      answerText(row, { messageID: row.info.id, partIDs: ["a", "b"] }),
      "  first\nline \n\nsecond\n\nlast",
    );
    assertThrows(() =>
      answerText({ ...row, info: { ...row.info, summary: true } }, {
        messageID: row.info.id,
        partIDs: ["a", "b"],
      })
    );
  } finally {
    await w.close();
  }
});

Deno.test("J5 C19 source lineage follows auto-compaction summary to marked synthetic continuation only", async () => {
  const w = await world();
  try {
    const compact: NativeMessage = {
      info: { id: "msg_compact", role: "user", time: { created: 5 } },
      parts: [{ id: "prt_compact", type: "compaction", auto: true }],
    };
    const summary: NativeMessage = {
      info: {
        ...w.final.info,
        id: "msg_summary",
        parentID: compact.info.id,
        summary: true,
        agent: "compaction",
      },
      parts: [{
        id: "prt_summary",
        type: "text",
        text: "INTERNAL SUMMARY NEVER POST",
      }],
    };
    const continuation: NativeMessage = {
      info: { id: "msg_continue", role: "user", time: { created: 7 } },
      parts: [{
        id: "prt_continue",
        type: "text",
        synthetic: true,
        metadata: { compaction_continue: true },
      }],
    };
    const final: NativeMessage = {
      ...w.final,
      info: { ...w.final.info, parentID: continuation.info.id },
    };
    const classify = (rows: NativeMessage[]) =>
      classifyCompletion({
        rows,
        wakeID: w.wake.info.id,
        submitEpoch: w.ports.epoch,
        epoch: w.ports.epoch,
        continuations: 0,
        storedAt: 4,
      });
    assertEquals(classify([w.wake, compact, summary, continuation, final]), {
      kind: "answer",
      answer: { messageID: final.info.id, partIDs: ["prt_answer"] },
    });
    const operator: NativeMessage = {
      info: { id: "msg_operator", role: "user", time: { created: 6 } },
      parts: [{
        id: "prt_operator",
        type: "text",
        text: "operator takes over",
      }],
    };
    assertEquals(
      classify([w.wake, compact, summary, operator, continuation, final]),
      { kind: "superseded_by_native_input", messageID: operator.info.id },
    );
    assertEquals(
      classify([w.wake, continuation, final]).kind,
      "interrupted_unanswered",
    );
  } finally {
    await w.close();
  }
});
