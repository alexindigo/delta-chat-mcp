// SPDX-License-Identifier: LGPL-3.0-only
import { startDeltaChat } from "@deltachat/stdio-rpc-server";
import { once } from "node:events";

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("RPC lifecycle timeout")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The npm wrapper remains the process owner; no replacement stdio transport. */
export async function startRpcProcess(accountsDir: string) {
  const client = startDeltaChat(accountsDir, { disableEnvPath: true });
  // The wrapper exposes its stdio streams, not the child handle. Observe their
  // closure before considering stop complete; tests also observe the actual PID.
  const closed = Promise.all([
    once(client.transport.input, "close"),
    once(client.transport.output, "close"),
  ]);
  let stopping: Promise<void> | undefined;
  function close(): Promise<void> {
    if (!stopping) {
      client.close();
      stopping = bounded(closed, 5_000).then(() => {});
    }
    return stopping;
  }
  try {
    await bounded(client.rpc.getSystemInfo(), 10_000);
  } catch (error) {
    await close();
    throw error;
  }
  // Expose only the spike's operations, never the raw client or transport.
  return {
    getSystemInfo: () => client.rpc.getSystemInfo(),
    addAccount: () => client.rpc.addAccount(),
    isConfigured: (id: number) => client.rpc.isConfigured(id),
    getAllAccountIds: () => client.rpc.getAllAccountIds(),
    close,
  };
}
