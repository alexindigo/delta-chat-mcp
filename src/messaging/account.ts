// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreClient } from "../core/client.ts";
import type { ChangeHub } from "../events.ts";

export class IdentityRequired extends Error {
  constructor() {
    super("Exactly one configured identity is required");
  }
}
export class AccountService {
  #creating = false;
  constructor(
    private readonly core: CoreClient,
    private readonly events: ChangeHub,
  ) {}
  async id(): Promise<number> {
    return await this.core.use(async (rpc) => {
      const ids = await rpc.getAllAccountIds();
      if (ids.length !== 1 || !await rpc.isConfigured(ids[0])) {
        throw new IdentityRequired();
      }
      return ids[0];
    });
  }
  status() {
    return this.core.use(async (rpc) => {
      const ids = await rpc.getAllAccountIds();
      if (ids.length > 1) throw new IdentityRequired();
      const accountId = ids[0] ?? null;
      if (accountId === null) {
        return {
          configured: false,
          accountId,
          address: null,
          displayName: null,
          connectivity: null,
        };
      }
      const configured = await rpc.isConfigured(accountId);
      return {
        configured,
        accountId,
        address: (await rpc.getTransportAddresses(accountId))[0] ?? null,
        displayName: await rpc.getConfig(accountId, "displayname"),
        connectivity: await rpc.getConnectivity(accountId),
      };
    });
  }
  async create(input: { relay: string; displayName: string }) {
    if (!input.relay.trim() || !input.displayName.trim()) {
      throw new Error("Relay and display name required");
    }
    if (this.#creating) throw new Error("Identity creation in progress");
    this.#creating = true;
    try {
      await this.core.use(async (rpc) => {
        const ids = await rpc.getAllAccountIds();
        if (ids.length > 1) throw new IdentityRequired();
        if (ids.length === 1 && await rpc.isConfigured(ids[0])) {
          throw new Error("Identity already exists");
        }
        // Allocation is durable even when provisioning fails. Resume that same
        // unconfigured identity; only core decides whether setup is complete.
        const id = ids[0] ?? await rpc.addAccount();
        await rpc.setConfig(id, "displayname", input.displayName.trim());
        await rpc.addTransportFromQr(id, `DCACCOUNT:${input.relay.trim()}`);
        await rpc.startIo(id);
      });
      this.events.emit({ type: "account" });
      return await this.status();
    } catch (error) {
      // RPC errors do not imply rollback (the provider may already have
      // committed its transport). Re-observe, including for health consumers.
      try {
        await this.status();
      } catch (stateError) {
        if (stateError instanceof IdentityRequired) throw stateError;
        throw new AggregateError(
          [error, stateError],
          "Identity state unavailable",
        );
      }
      throw error;
    } finally {
      this.#creating = false;
    }
  }
  async inviteLink() {
    const id = await this.id();
    return await this.core.use((rpc) => rpc.getChatSecurejoinQrCode(id, null));
  }
  async inviteQrSvg() {
    const link = await this.inviteLink();
    return await this.core.use((rpc) => rpc.createQrSvg(link));
  }
}
