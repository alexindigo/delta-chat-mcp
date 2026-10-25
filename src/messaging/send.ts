// SPDX-License-Identifier: LGPL-3.0-only
import { type CoreClient, type CoreRpc, messageState } from "../core/client.ts";
import type { AccountService } from "./account.ts";
import { requireId, requireIds } from "./validation.ts";
import { loadMessages } from "./load.ts";
export class SendService {
  constructor(
    private readonly core: CoreClient,
    private readonly account: AccountService,
  ) {}
  async #send(
    text: string,
    resolveChat: (rpc: CoreRpc, accountId: number) => Promise<number>,
  ) {
    if (!text.length) throw new Error("Message text required");
    const id = await this.account.id();
    return await this.core.use(async (rpc) => {
      const chatId = await resolveChat(rpc, id);
      const messageId = await rpc.miscSendTextMessage(id, chatId, text);
      return {
        messageId,
        chatId,
        state: messageState((await rpc.getMessage(id, messageId)).state),
      };
    });
  }
  sendText(chatId: number, text: string) {
    requireId(chatId);
    return this.#send(text, () => Promise.resolve(chatId));
  }
  async sendTextToContact(contactId: number, text: string) {
    requireId(contactId);
    return await this.#send(
      text,
      (rpc, id) => rpc.createChatByContactId(id, contactId),
    );
  }
  async status(ids: readonly number[]) {
    const selected = requireIds(ids);
    if (!selected.length) return [];
    const id = await this.account.id();
    return await this.core.use(async (rpc) => {
      const loaded = await loadMessages(rpc, id, selected);
      return selected.map((messageId) => ({
        messageId,
        state: loaded.has(messageId)
          ? messageState(loaded.get(messageId)!.state)
          : "not_found" as const,
      }));
    });
  }
}
