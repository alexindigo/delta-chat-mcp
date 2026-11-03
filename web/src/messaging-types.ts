// SPDX-License-Identifier: LGPL-3.0-only
export interface Account {
  core: "ready" | "restarting";
  configured: boolean;
  accountId: number | null;
  address: string | null;
  displayName: string | null;
  connectivity: number | null;
}
export interface Contact {
  id: number;
  address: string;
  displayName: string;
  isBlocked: boolean;
  isKeyContact: boolean;
  e2eeAvail: boolean;
}
export type ChatType =
  | "Single"
  | "Group"
  | "Mailinglist"
  | "OutBroadcast"
  | "InBroadcast";
export interface ChatRow {
  id: number;
  name: string;
  type: ChatType;
  isEncrypted: boolean;
  isContactRequest: boolean;
  freshMessageCount: number;
  lastMessageId: number | null;
  lastMessageTime: number | null;
  contactIds: number[];
  summary: string;
}
export interface ChatDetail {
  id: number;
  name: string;
  type: ChatType;
  isEncrypted: boolean;
  isContactRequest: boolean;
  freshMessageCount: number;
  contactIds: number[];
  canSend: boolean;
  isUnpromoted: boolean;
  selfInGroup: boolean;
}
export interface Message {
  id: number;
  chatId: number;
  fromContactId: number;
  fromSelf: boolean;
  text: string;
  textComplete: boolean;
  html?: string;
  fromName: string;
  fromAddress: string;
  isInfo: boolean;
  isBot: boolean;
  isForwarded: boolean;
  quote?: { text: string; messageId?: number; authorName?: string };
  timestamp: number;
  state: string;
  hasAttachment: boolean;
  encrypted: boolean;
  attachmentName?: string;
  inlineImage?: {
    mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    width?: number;
    height?: number;
  };
  attachmentDownloadState?:
    | "Done"
    | "Available"
    | "InProgress"
    | "Failure"
    | "Undecipherable";
}
export interface Invite {
  link: string;
  svg: string;
}
export interface MessagingApi {
  account(): Promise<Account>;
  createIdentity(
    input: { relay: string; displayName: string },
  ): Promise<unknown>;
  invite(): Promise<Invite>;
  contacts(): Promise<{ contacts: Contact[] }>;
  join(link: string): Promise<{ chatId: number }>;
  openChat(contact: number): Promise<{ chatId: number }>;
  request(chat: number, action: "accept" | "block"): Promise<unknown>;
  chats(): Promise<{ chats: ChatRow[] }>;
  chat(id: number): Promise<ChatDetail>;
  messages(id: number, beforeId?: number): Promise<{ messages: Message[] }>;
  send(
    id: number,
    text: string,
  ): Promise<{ messageId: number; chatId: number; state: string }>;
  seen(id: number, ids: number[]): Promise<unknown>;
  removeMessages(ids: number[]): Promise<unknown>;
}
