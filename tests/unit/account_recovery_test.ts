// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { CoreClient, CoreRpc } from "../../src/core/client.ts";
import { CoreProcess } from "../../src/core/process.ts";
import { ChangeHub } from "../../src/events.ts";
import {
  AccountService,
  IdentityRequired,
} from "../../src/messaging/account.ts";
import { deadline, fixture } from "../support.ts";
import { publicKeys } from "../account_keys.ts";

class ProvisioningFailure extends Error {}

Deno.test("actual unconfigured identity resumes provisioning immediately and after restart without replacing ID or keys", async () => {
  const accountsDir = await fixture("account-recovery");
  let core = new CoreProcess({ accountsDir });
  let attempts = 0;
  const providerIds: number[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const client: CoreClient = {
    use<T>(operation: (rpc: CoreRpc) => Promise<T>): Promise<T> {
      return core.use((rpc) =>
        operation({
          ...rpc,
          // Only the external provider operation is injected. All identity,
          // configuration, keys and persistence are the selected actual core.
          addTransportFromQr: async (id) => {
            providerIds.push(id);
            if (++attempts === 1) {
              entered.resolve();
              await release.promise;
            }
            throw new ProvisioningFailure("Provider unavailable");
          },
        })
      );
    },
  };
  const input = {
    relay: "ci-chatmail.testrun.org",
    displayName: "Retry fixture",
  };
  try {
    await deadline(core.start());
    let account = new AccountService(client, new ChangeHub());
    const first = assertRejects(
      () => account.create(input),
      ProvisioningFailure,
    );
    await deadline(entered.promise);
    await assertRejects(() => account.create(input), Error, "in progress");
    const allocated = await account.status();
    assert(allocated.accountId !== null);
    const id = allocated.accountId;
    assertEquals(allocated.configured, false);
    assertEquals(allocated.displayName, input.displayName);
    await assertRejects(() => account.id(), IdentityRequired);
    // Fresh unconfigured core may not have generated keys yet. Compare actual
    // records; successful real-relay provisioning/partial completion is online.
    const keys = await publicKeys(accountsDir);
    release.resolve();
    await deadline(first);
    await assertRejects(() => account.create(input), ProvisioningFailure);
    assertEquals(await core.use((rpc) => rpc.getAllAccountIds()), [id]);
    assertEquals(await publicKeys(accountsDir), keys);
    await deadline(core.close());
    core = new CoreProcess({ accountsDir });
    await deadline(core.start());
    account = new AccountService(client, new ChangeHub());
    assertEquals((await account.status()).accountId, id);
    await assertRejects(() => account.create(input), ProvisioningFailure);
    assertEquals(providerIds, [id, id, id]);
    assertEquals(await core.use((rpc) => rpc.getAllAccountIds()), [id]);
    assertEquals(await publicKeys(accountsDir), keys);
    assertEquals((await account.status()).configured, false);
    await assertRejects(() => account.id(), IdentityRequired);
  } finally {
    release.resolve();
    await deadline(core.close());
  }
});

Deno.test("ambiguous actual core identities are rejected without allocating or changing either", async () => {
  const core = new CoreProcess({
    accountsDir: await fixture("account-ambiguous"),
  });
  try {
    await deadline(core.start());
    const ids = await core.use(async (
      rpc,
    ) => [await rpc.addAccount(), await rpc.addAccount()]);
    const account = new AccountService(core, new ChangeHub());
    await assertRejects(
      () =>
        account.create({
          relay: "ci-chatmail.testrun.org",
          displayName: "Unused",
        }),
      IdentityRequired,
    );
    assertEquals(await core.use((rpc) => rpc.getAllAccountIds()), ids);
    for (const id of ids) {
      assertEquals(await core.use((rpc) => rpc.isConfigured(id)), false);
      assertEquals(
        await core.use((rpc) => rpc.getConfig(id, "displayname")),
        null,
      );
    }
  } finally {
    await deadline(core.close());
  }
});
