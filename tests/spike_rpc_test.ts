// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { startRpcProcess } from "../src/core/rpc-process.ts";
import { deadline, fixture, poll } from "./support.ts";

async function corePids(): Promise<number[]> {
  const result = await new Deno.Command("pgrep", {
    args: ["-P", String(Deno.pid), "-f", "deltachat-rpc-server"],
  }).output();
  if (result.code === 1) return [];
  assertEquals(result.code, 0);
  return new TextDecoder().decode(result.stdout).trim().split(/\s+/).map(
    Number,
  );
}

Deno.test("RPC 2.65.0 creates an offline unconfigured account and exits", async () => {
  assertEquals(await corePids(), []);
  const core = await startRpcProcess(await fixture("rpc"));
  const pids = await corePids();
  try {
    assertEquals(pids.length, 1);
    const info = await deadline(core.getSystemInfo());
    assertEquals(info.deltachat_core_version, "v2.65.0");
    const id = await deadline(core.addAccount());
    assert(id > 0);
    assertEquals(await deadline(core.isConfigured(id)), false);
    console.log(
      `core=${info.deltachat_core_version}; unconfigured=${id}; pid=${pids[0]}`,
    );
  } finally {
    await core.close();
  }
  await poll(async () => (await corePids()).length === 0);
  assertEquals(await corePids(), []);
});

Deno.test("RPC account survives a complete core process restart", async () => {
  const dir = await fixture("rpc");
  const first = await startRpcProcess(dir);
  let id: number;
  try {
    id = await deadline(first.addAccount());
  } finally {
    await first.close();
  }
  await poll(async () => (await corePids()).length === 0);
  assert((await Deno.stat(dir)).isDirectory);
  const second = await startRpcProcess(dir);
  try {
    assertEquals(await deadline(second.getAllAccountIds()), [id]);
    assertEquals(await deadline(second.isConfigured(id)), false);
    console.log(`restarted account=${id}; persisted in ${dir}`);
  } finally {
    await second.close();
  }
  await poll(async () => (await corePids()).length === 0);
  assertEquals(await corePids(), []);
});
