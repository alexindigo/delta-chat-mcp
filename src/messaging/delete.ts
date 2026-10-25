// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreClient } from "../core/client.ts";
import type { AccountService } from "./account.ts";
import { requireIds } from "./validation.ts";
export class DeleteService {
  constructor(
    private readonly core: CoreClient,
    private readonly account: AccountService,
  ) {}
  async deleteMessages(ids: readonly number[]): Promise<void> {
    const messages = requireIds(ids);
    if (!messages.length) return;
    const id = await this.account.id();
    await this.core.use((rpc) => rpc.deleteMessages(id, messages));
  }
}
