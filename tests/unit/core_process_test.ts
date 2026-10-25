// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { CoreProcess, type CoreState } from "../../src/core/process.ts";
import { CoreRpcError, CoreUnavailable } from "../../src/core/client.ts";
import { deadline, fixture, poll } from "../support.ts";

function exists(pid: number) {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
Deno.test("owned core survives crash, rejects unavailable calls and preserves identity", async () => {
  const states: CoreState[] = [];
  const core = new CoreProcess({
    accountsDir: await fixture("core"),
    onState: (state) => states.push(state),
  });
  await assertRejects(
    () => core.use((rpc) => rpc.getSystemInfo()),
    CoreUnavailable,
  );
  const starting = core.start();
  await assertRejects(() => core.start(), Error, "already started");
  await deadline(starting);
  let lastPid: number | undefined;
  try {
    assertEquals(core.state, "ready");
    assertEquals(
      (await core.use((rpc) => rpc.getSystemInfo())).deltachat_core_version,
      "v2.65.0",
    );
    const account = await core.use((rpc) => rpc.addAccount());
    const failure = await assertRejects(
      () => core.use((rpc) => rpc.getMessage(account, 0xffffffff)),
      CoreRpcError,
    );
    assertEquals(failure.method, "getMessage");
    const pid = core.pid!;
    assert(exists(pid));
    Deno.kill(pid, "SIGKILL");
    await poll(() => core.state === "restarting");
    await assertRejects(
      () => core.use((rpc) => rpc.getAllAccountIds()),
      CoreUnavailable,
    );
    await poll(() => core.state === "ready", 10000);
    lastPid = core.pid;
    assert(lastPid !== pid);
    assertEquals(await core.use((rpc) => rpc.getAllAccountIds()), [account]);
    assertEquals(await core.use((rpc) => rpc.isConfigured(account)), false);
    assertEquals(exists(pid), false);
    assertEquals(states.slice(0, 3), ["ready", "restarting", "ready"]);
  } finally {
    await deadline(core.close());
  }
  assertEquals(core.state, "stopped");
  if (lastPid) assertEquals(exists(lastPid), false);
  await core.close();
});
Deno.test("generic QR works before identity setup and stderr emits metadata only", async () => {
  const diagnostics: unknown[] = [];
  const core = new CoreProcess({
    accountsDir: await fixture("core"),
    onDiagnostic: (kind, fields) => diagnostics.push({ kind, fields }),
  });
  await deadline(core.start());
  const pid = core.pid!;
  try {
    const svg = await core.use((rpc) =>
      rpc.createQrSvg(
        "otpauth://totp/delta-chat-mcp:fixture?secret=JBSWY3DPEHPK3PXP&issuer=delta-chat-mcp",
      )
    );
    assert(svg.includes("<svg"));
    assert(svg.includes("path"));
    assertEquals(await core.use((rpc) => rpc.getAllAccountIds()), []);
    assert(!JSON.stringify(diagnostics).includes("JBSWY3DPEHPK3PXP"));
  } finally {
    await deadline(core.close());
  }
  assertEquals(exists(pid), false);
});
