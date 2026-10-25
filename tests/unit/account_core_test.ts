// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { startRpcProcess } from "../../src/core/rpc-process.ts";
import { CoreProcess } from "../../src/core/process.ts";
import { AccountService } from "../../src/messaging/account.ts";
import { ChangeHub } from "../../src/events.ts";
import { deadline, fixture } from "../support.ts";

Deno.test("actual 2.65 account status projects configured transport address without credentials", async () => {
  const accountsDir = await fixture("account-core");
  const setup = await startRpcProcess(accountsDir);
  try {
    const id = await setup.addAccount();
    await setup.addPseudoTransport(id, "fixture@relay.example");
  } finally {
    await setup.close();
  }
  const core = new CoreProcess({ accountsDir });
  await deadline(core.start());
  try {
    const status = await new AccountService(core, new ChangeHub()).status();
    assertEquals(status.configured, true);
    assertEquals(status.address, "fixture@relay.example");
    assertEquals(
      await core.use((rpc) => rpc.getTransportAddresses(status.accountId!)),
      ["fixture@relay.example"],
    );
    assertEquals(
      await core.use((rpc) =>
        Promise.resolve(Reflect.has(rpc, "listTransports"))
      ),
      false,
    );
    await assertRejects(
      () =>
        core.use((rpc) =>
          rpc.getConfig(status.accountId!, "addr" as "displayname")
        ),
      Error,
      "Unsupported",
    );
    assertEquals(Object.keys(status).sort(), [
      "accountId",
      "address",
      "configured",
      "connectivity",
      "displayName",
    ]);
  } finally {
    await deadline(core.close());
  }
});
