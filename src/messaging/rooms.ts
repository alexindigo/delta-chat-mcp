// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CoreClient,
  type CoreRpc,
  isSelfContact,
} from "../core/client.ts";
import type { AccountService } from "./account.ts";
import { requireId, requireIds } from "./validation.ts";
import { RoomSetupError } from "./room-outcome.ts";

type FullChat = Awaited<ReturnType<CoreRpc["getFullChatById"]>>;
const validTarget = (chat: FullChat) =>
  chat.chatType === "Group" && chat.isEncrypted && chat.selfInGroup &&
  chat.contactIds.some(isSelfContact);

export class RoomsService {
  constructor(
    private readonly core: CoreClient,
    private readonly account: AccountService,
  ) {}
  async createRoom(name: string, contactIds: readonly number[]) {
    if (!name.trim()) throw new Error("Room name required");
    const members = requireIds(contactIds);
    if (members.length > 100) throw new Error("Too many room contacts");
    const id = await this.account.id();
    // Keep allocation facts outside the generation callback: generation loss
    // can reject use() after an RPC has already returned a real ID.
    let chatId: number | undefined, attempted = false;
    try {
      return await this.core.use(async (rpc) => {
        await this.preflight(rpc, id, members);
        attempted = true;
        chatId = await rpc.createGroupChat(id, name.trim(), false);
        for (const member of members) {
          await rpc.addContactToChat(id, chatId, member);
        }
        await this.verify(rpc, id, chatId, members);
        return { chatId };
      });
    } catch (error) {
      if (chatId !== undefined) {
        throw await this.incomplete(id, chatId, members);
      }
      if (!attempted) throw error;
      throw new RoomSetupError({
        kind: "uncertain",
        message:
          "Creation was not acknowledged. A room may exist. Inspect Conversations before deliberately creating another room.",
      });
    }
  }
  async completeRoom(chatId: number, contactIds: readonly number[]) {
    requireId(chatId);
    const members = requireIds(contactIds);
    if (members.length > 100) throw new Error("Too many room contacts");
    const id = await this.account.id();
    try {
      return await this.core.use(async (rpc) => {
        const chat = await rpc.getFullChatById(id, chatId);
        if (chat.id !== chatId || !validTarget(chat) || !chat.isUnpromoted) {
          throw new RoomSetupError({
            kind: "incomplete",
            chatId,
            intendedContactIds: members,
            missingContactIds: members.filter((member) =>
              !chat.contactIds.includes(member)
            ),
            completionStopped: true,
            message:
              "Setup cannot continue: this room was distributed, is no longer an encrypted Group, or this identity left it. Open the room or dismiss setup; the room is kept.",
          });
        }
        await this.preflight(rpc, id, members);
        for (const member of members) {
          if (!chat.contactIds.includes(member)) {
            await rpc.addContactToChat(id, chatId, member);
          }
        }
        await this.verify(rpc, id, chatId, members);
        return { chatId };
      });
    } catch (error) {
      if (
        error instanceof RoomSetupError && error.outcome.kind === "incomplete"
      ) throw error;
      throw await this.incomplete(id, chatId, members);
    }
  }
  private async preflight(rpc: CoreRpc, id: number, members: number[]) {
    const contacts = await rpc.getContacts(id, 0, null);
    if (
      members.some((member) =>
        !contacts.some((contact) =>
          contact.id === member && !contact.isBlocked && contact.isKeyContact &&
          contact.e2eeAvail
        )
      )
    ) {
      throw new RoomSetupError({
        kind: "rejected",
        message:
          "Every selected contact must still be an unblocked key contact with encryption available. Refresh contacts and review the selection. No room was created.",
      });
    }
  }
  private async verify(
    rpc: CoreRpc,
    id: number,
    chatId: number,
    members: number[],
  ) {
    const chat = await rpc.getFullChatById(id, chatId);
    if (
      chat.id !== chatId || !validTarget(chat) ||
      members.some((member) => !chat.contactIds.includes(member))
    ) {
      throw new Error("Room postcondition not met");
    }
  }
  private async incomplete(id: number, chatId: number, members: number[]) {
    let chat: FullChat | undefined;
    try {
      chat = await this.core.use((rpc) => rpc.getFullChatById(id, chatId));
    } catch { /* Unknown membership is distinct from an empty missing set. */ }
    const stopped = !!chat && (!validTarget(chat) || !chat.isUnpromoted);
    return new RoomSetupError({
      kind: "incomplete",
      chatId,
      intendedContactIds: members,
      missingContactIds: chat
        ? members.filter((member) => !chat.contactIds.includes(member))
        : null,
      completionStopped: stopped,
      message: stopped
        ? "The room exists, but setup cannot continue after distribution or removal of this identity. Open it or dismiss setup; the room is kept."
        : "The room exists, but all intended membership could not be confirmed. Retry adding contacts to this same room, or open it to inspect. Your input is kept.",
    });
  }
}
