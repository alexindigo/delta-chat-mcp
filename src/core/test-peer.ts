// SPDX-License-Identifier: LGPL-3.0-only
// Independent plain upstream npm peer for the isolated online proofs only.
import { startDeltaChat } from "@deltachat/stdio-rpc-server";
import { once } from "node:events";
import { type CoreEvent, type CoreRpc, createCoreFacade } from "./client.ts";

export async function startTestPeer(
  accountsDir: string,
  onEvent: (event: CoreEvent) => void,
) {
  await Deno.mkdir(accountsDir, { recursive: true, mode: 0o700 });
  const client = startDeltaChat(accountsDir, {
    disableEnvPath: true,
    muteStdErr: true,
  });
  const closed = Promise.all([
    once(client.transport.input, "close"),
    once(client.transport.output, "close"),
  ]);
  client.on("ALL", (_account, event) => onEvent(event));
  const rpc = createCoreFacade(client.rpc);
  let stopping: Promise<void> | undefined;
  async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Peer deadline exceeded")),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function close(): Promise<void> {
    if (!stopping) {
      client.close();
      stopping = bounded(closed, 10000).then(() => {});
    }
    return stopping;
  }
  try {
    await bounded(rpc.getSystemInfo(), 10000);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    call: <T>(operation: (client: CoreRpc) => Promise<T>) =>
      bounded(operation(rpc), 120000),
    close,
  };
}
