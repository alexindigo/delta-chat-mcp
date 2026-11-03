// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { classifyCompletion } from "../../integrations/opencode/completion.ts";
import type { NativeMessage } from "../../integrations/opencode/types.ts";

const user = (
  id: string,
  created: number,
  metadata?: Record<string, unknown>,
  synthetic = false,
): NativeMessage => ({
  info: { id, role: "user", time: { created } },
  parts: [{
    id: `prt_${id}`,
    type: "text",
    text: id,
    ...(metadata ? { metadata } : {}),
    synthetic,
  }],
});
const assistant = (
  parentID: string,
  finish = "stop",
  error?: string,
): NativeMessage => ({
  info: {
    id: `answer_${parentID}`,
    parentID,
    role: "assistant",
    time: { created: 3, completed: 4 },
    finish,
    ...(error ? { error: { name: error } } : {}),
  },
  parts: [{ id: `prt_answer_${parentID}`, type: "text", text: "answer" }],
});
const wake = user("U", 2, { deltaChatWake: { v: 1 } });
const classify = (rows: NativeMessage[], extra = {}) =>
  classifyCompletion({
    rows,
    wakeID: "U",
    epoch: "same",
    submitEpoch: "same",
    continuations: 0,
    storedAt: 2,
    ...extra,
  });

Deno.test("J4 completion table rows1–8 use only canonical structural facts", () => {
  assertEquals(classify([wake, assistant("U")]), {
    kind: "answer",
    answer: { messageID: "answer_U", partIDs: ["prt_answer_U"] },
  });
  assertEquals(
    classify([wake, assistant("U", "unknown", "MessageAbortedError")]),
    { kind: "aborted" },
  );
  assertEquals(classify([wake, assistant("U", "unknown", "OtherError")]), {
    kind: "failed",
  });
  assertEquals(classify([wake, user("O", 3), assistant("O")]), {
    kind: "superseded_by_native_input",
    messageID: "O",
  });
  assertEquals(classify([wake], { epoch: "new" }), {
    kind: "continuation",
    reason: "epoch_change",
  });
  assertEquals(classify([user("old", 1), wake, assistant("old")]), {
    kind: "continuation",
    reason: "join_race",
  });
  assertEquals(classify([wake], { sessionError: true }), { kind: "failed" });
  assertEquals(classify([wake]), { kind: "interrupted_unanswered" });
});
Deno.test("J4 runtime/synthetic rows do not supersede; native input bounds continuations and old answers", () => {
  assertEquals(
    classify([
      wake,
      user("synthetic", 3, undefined, true),
      user("notice", 4, { deltaChatNotice: true }),
      assistant("U"),
    ]).kind,
    "answer",
  );
  const continuation = user("C", 3, { deltaChatWake: { continuationOf: "U" } });
  assertEquals(
    classifyCompletion({
      rows: [wake, continuation, user("O", 4), assistant("C")],
      wakeID: "C",
      epoch: "new",
      submitEpoch: "old",
      continuations: 1,
      storedAt: 3,
    }),
    { kind: "superseded_by_native_input", messageID: "O" },
  );
  assertEquals(classify([wake], { epoch: "new", continuations: 2 }), {
    kind: "stalled",
  });
  assertEquals(
    classify([wake, user("O", 3), assistant("U")], { epoch: "new" }),
    { kind: "superseded_by_native_input", messageID: "O" },
  );
  assertEquals(
    classify([user("old", 1), wake, assistant("old")], { storedAt: 5 }),
    { kind: "interrupted_unanswered" },
  );
});
