// SPDX-License-Identifier: LGPL-3.0-only
import type { NativeMessage } from "./types.ts";

function isAutoCompaction(row: NativeMessage): boolean {
  return row.info.role === "user" && row.parts.length > 0 &&
    row.parts.every((p) => p.type === "compaction" && p.auto === true);
}
export function isNativeInput(row: NativeMessage): boolean {
  return row.info.role === "user" &&
    !isAutoCompaction(row) &&
    !row.parts.some((p) =>
      p.metadata?.deltaChatWake !== undefined ||
      p.metadata?.deltaChatNotice !== undefined
    ) && !(row.parts.length > 0 && row.parts.every((p) => p.synthetic));
}
export interface NativeAnswer {
  messageID: string;
  partIDs: string[];
}
/** Re-read exact native references; never use reasoning, tool output, summaries
 * or a preview. Whitespace determines substance, never rewrites the answer. */
export function answerText(row: NativeMessage, answer: NativeAnswer): string {
  if (
    row.info.id !== answer.messageID || row.info.role !== "assistant" ||
    row.info.summary === true || row.info.agent === "compaction" ||
    row.info.error ||
    !row.info.finish || ["tool-calls", "unknown"].includes(row.info.finish)
  ) {
    throw new Error("Native final answer unavailable");
  }
  const parts = row.parts.filter((p) =>
    p.type === "text" && !p.synthetic && !p.ignored
  );
  if (
    JSON.stringify(parts.map((p) => p.id)) !== JSON.stringify(answer.partIDs) ||
    parts.some((p) => typeof p.text !== "string")
  ) throw new Error("Native answer references changed");
  return parts.map((p) => p.text!).filter((text) => text.trim().length > 0)
    .join("\n\n");
}
export function wakeAssistants(
  rows: readonly NativeMessage[],
  wakeID: string,
): NativeMessage[] {
  const start = rows.findIndex((r) => r.info.id === wakeID);
  if (start < 0) return [];
  const later = rows.slice(start + 1);
  const boundary = later.findIndex(isNativeInput);
  const parents = new Set([wakeID]);
  const result: NativeMessage[] = [];
  let owned = true, compactID: string | undefined, summarized = false;
  // Pinned prompt.ts:1149–1167 and compaction.ts:393–418,497–547:
  // auto compaction has NO parentID link to U; its summary parents the compaction
  // user, then a marked synthetic user owns the resumed answer. Follow this
  // structural sequence in core transcript order, never text or guessed IDs.
  for (const row of boundary < 0 ? later : later.slice(0, boundary)) {
    if (isAutoCompaction(row) && owned) {
      compactID = row.info.id;
      summarized = false;
      continue;
    }
    if (row.info.role === "assistant") {
      if (
        compactID && row.info.parentID === compactID &&
        row.info.summary === true && row.info.agent === "compaction"
      ) {
        summarized = !!row.info.finish && !row.info.error;
        if (row.info.error) result.push(row);
      } else if (
        row.info.parentID && parents.has(row.info.parentID) &&
        row.info.summary !== true && row.info.agent !== "compaction"
      ) result.push(row);
      continue;
    }
    if (
      owned && compactID && summarized && row.parts.length > 0 &&
      row.parts.every((p) =>
        p.type === "text" && p.synthetic === true &&
        p.metadata?.compaction_continue === true
      )
    ) {
      parents.add(row.info.id);
      compactID = undefined;
      summarized = false;
    } else if (row.parts.some((p) => p.metadata?.deltaChatWake !== undefined)) {
      // A different runtime delivery is not a continuation of this source turn.
      owned = false;
      compactID = undefined;
      summarized = false;
    }
  }
  return result;
}
export type Completion =
  | { kind: "answer"; answer: NativeAnswer }
  | { kind: "aborted" | "failed" | "interrupted_unanswered" | "stalled" }
  | { kind: "superseded_by_native_input"; messageID: string }
  | { kind: "continuation"; reason: "epoch_change" | "join_race" };

/** Revision2 B: only structural facts, in the API's canonical transcript order.
 * Caller establishes idle; no text interpretation and no optimistic retry. */
export function classifyCompletion(input: {
  rows: readonly NativeMessage[];
  wakeID: string;
  submitEpoch: string;
  epoch: string;
  continuations: number;
  // Positive native lookup time, not user time.created (which precedes the
  // pre-persistence hook). Conservative evidence that U was already stored.
  storedAt: number;
  sessionError?: boolean;
}): Completion {
  const start = input.rows.findIndex((row) => row.info.id === input.wakeID);
  if (start < 0) return { kind: "interrupted_unanswered" };
  const later = input.rows.slice(start + 1);
  const boundary = later.findIndex(isNativeInput);
  const assistants = wakeAssistants(input.rows, input.wakeID);
  const final = assistants.findLast((row) =>
    !!row.info.finish && !["tool-calls", "unknown"].includes(row.info.finish) &&
    !row.info.error && row.info.summary !== true &&
    row.info.agent !== "compaction"
  );
  if (final) {
    return {
      kind: "answer",
      answer: {
        messageID: final.info.id,
        partIDs: final.parts.filter((p) =>
          p.type === "text" && !p.synthetic && !p.ignored
        ).map((p) => p.id),
      },
    };
  }
  const error = assistants.findLast((row) => row.info.error)?.info.error;
  if (error) {
    return {
      kind: error.name === "MessageAbortedError" ? "aborted" : "failed",
    };
  }
  if (boundary >= 0) {
    return {
      kind: "superseded_by_native_input",
      messageID: later[boundary].info.id,
    };
  }
  const continuation = (reason: "epoch_change" | "join_race"): Completion =>
    input.continuations < 2
      ? { kind: "continuation", reason }
      : { kind: "stalled" };
  if (input.submitEpoch !== input.epoch) return continuation("epoch_change");
  const olderNative = new Set(
    input.rows.slice(0, start).filter(isNativeInput).map((row) => row.info.id),
  );
  const join = assistants.length === 0 &&
    input.rows.some((row) =>
      row.info.role === "assistant" && !!row.info.parentID &&
      olderNative.has(row.info.parentID) && !!row.info.finish &&
      !["tool-calls", "unknown"].includes(row.info.finish) && !row.info.error &&
      (row.info.time.completed ?? -1) > input.storedAt
    );
  if (join) return continuation("join_race");
  if (input.sessionError) return { kind: "failed" };
  return { kind: "interrupted_unanswered" };
}
