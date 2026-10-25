// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreClient } from "../core/client.ts";
import type { AccountService } from "./account.ts";
import { requireId } from "./validation.ts";

export class ContactsService {
  constructor(
    private readonly core: CoreClient,
    private readonly account: AccountService,
  ) {}
  async list() {
    const id = await this.account.id();
    return await this.core.use(async (rpc) =>
      (await rpc.getContacts(id, 0, null)).map((contact) => ({
        id: contact.id,
        address: contact.address,
        displayName: contact.displayName,
        isBlocked: contact.isBlocked,
        isKeyContact: contact.isKeyContact,
        e2eeAvail: contact.e2eeAvail,
      }))
    );
  }
  async joinByInvite(link: string) {
    const id = await this.account.id();
    return await this.core.use(async (rpc) => {
      const qr = await rpc.checkQr(id, link);
      if (qr.kind !== "askVerifyContact" && qr.kind !== "askVerifyGroup") {
        throw new Error("Not a SecureJoin invitation");
      }
      return { chatId: await rpc.secureJoin(id, link) };
    });
  }
  async accept(chatId: number): Promise<void> {
    requireId(chatId);
    const id = await this.account.id();
    await this.core.use((rpc) => rpc.acceptChat(id, chatId));
  }
  async openChat(contactId: number) {
    requireId(contactId);
    const id = await this.account.id();
    return {
      chatId: await this.core.use((rpc) =>
        rpc.createChatByContactId(id, contactId)
      ),
    };
  }
  async block(chatId: number): Promise<void> {
    requireId(chatId);
    const id = await this.account.id();
    await this.core.use((rpc) => rpc.blockChat(id, chatId));
  }
}
