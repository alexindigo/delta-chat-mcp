// SPDX-License-Identifier: LGPL-3.0-only
/** Safe domain facts only: no backend messages, credentials or paths. */
export type RoomOutcome =
  | { kind: "rejected"; message: string }
  | { kind: "uncertain"; message: string }
  | {
    kind: "incomplete";
    message: string;
    chatId: number;
    intendedContactIds: number[];
    missingContactIds: number[] | null;
    completionStopped: boolean;
  };

export class RoomSetupError extends Error {
  constructor(readonly outcome: RoomOutcome) {
    super(outcome.message);
    this.name = "RoomSetupError";
  }
}

/** Transport decoder keeps arbitrary response objects out of recovery policy. */
export function readRoomOutcome(value: unknown): RoomOutcome | undefined {
  if (
    !value || typeof value !== "object" || !("kind" in value) ||
    !("message" in value) || typeof value.message !== "string"
  ) return;
  if (value.kind === "rejected" || value.kind === "uncertain") {
    return { kind: value.kind, message: value.message };
  }
  const validId = (id: unknown): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0 &&
    id <= 0xffffffff;
  const validIds = (ids: unknown): ids is number[] =>
    Array.isArray(ids) && ids.length <= 100 && ids.every(validId);
  if (
    value.kind === "incomplete" && "chatId" in value && validId(value.chatId) &&
    "intendedContactIds" in value && validIds(value.intendedContactIds) &&
    "missingContactIds" in value &&
    (value.missingContactIds === null || validIds(value.missingContactIds)) &&
    "completionStopped" in value && typeof value.completionStopped === "boolean"
  ) {
    return {
      kind: "incomplete",
      message: value.message,
      chatId: value.chatId,
      intendedContactIds: value.intendedContactIds,
      missingContactIds: value.missingContactIds,
      completionStopped: value.completionStopped,
    };
  }
}
