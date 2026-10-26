// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreMessage, CoreRpc } from "../core/client.ts";

export class MessageLoadError extends Error {
  constructor() {
    super("Unable to load existing message");
    this.name = "MessageLoadError";
  }
}

/** Both history and status distinguish a concurrent delete from a load failure. */
export async function loadMessages(
  rpc: CoreRpc,
  account: number,
  ids: readonly number[],
): Promise<Map<number, CoreMessage>> {
  if (!ids.length) return new Map();
  const loaded = await rpc.getMessages(account, [...ids]);
  const missing = ids.filter((id) =>
    !loaded[id] || loaded[id].kind === "loadingError"
  );
  if (
    missing.length && (await rpc.getExistingMsgIds(account, missing)).length
  ) throw new MessageLoadError();
  return new Map(ids.flatMap((id) => {
    const message = loaded[id];
    return !message || message.kind === "loadingError"
      ? []
      : [[id, message] as const];
  }));
}
