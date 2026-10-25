// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreClient } from "../core/client.ts";
import type { AccountService } from "./account.ts";
import { requireIds } from "./validation.ts";

export class RoomsService {
  constructor(
    private readonly core: CoreClient,
    private readonly account: AccountService,
  ) {}
  async createRoom(name: string, contactIds: readonly number[]) {
    if (!name.trim()) throw new Error("Room name required");
    const members = requireIds(contactIds);
    const id = await this.account.id();
    return await this.core.use(async (rpc) => {
      const chatId = await rpc.createGroupChat(id, name.trim(), false);
      for (const member of members) {
        await rpc.addContactToChat(id, chatId, member);
      }
      return { chatId };
    });
  }
}
