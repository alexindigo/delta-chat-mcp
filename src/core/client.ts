// SPDX-License-Identifier: LGPL-3.0-only
import type { RawClient } from "@deltachat/jsonrpc-client";
import type { DcEvent } from "@deltachat/jsonrpc-client";
import type { ChangeHub } from "../events.ts";

/** One explicit allowlist defines both the runtime and typed RPC boundary. */
const methods = [
  "getSystemInfo",
  "getAllAccountIds",
  "addAccount",
  "isConfigured",
  "setConfig",
  "addTransportFromQr",
  "startIo",
  "getChatSecurejoinQrCode",
  "createQrSvg",
  "getConnectivity",
  "getContacts",
  "checkQr",
  "secureJoin",
  "acceptChat",
  "blockChat",
  "createGroupChat",
  "addContactToChat",
  "getChatlistEntries",
  "getChatlistItemsByEntries",
  "getFullChatById",
  "getMessageIds",
  "getMessage",
  "getMessages",
  "markseenMsgs",
  "createChatByContactId",
  "miscSendTextMessage",
  "deleteMessages",
] as const;
export type CoreRpc = Pick<RawClient, (typeof methods)[number]> & {
  getTransportAddresses(accountId: number): Promise<string[]>;
  getConfig(accountId: number, key: "displayname"): Promise<string | null>;
};
export function createCoreFacade(raw: RawClient): CoreRpc {
  const operations = Object.fromEntries(
    methods.map((name) => [name, raw[name].bind(raw)]),
  );
  return Object.freeze({
    ...operations,
    getTransportAddresses: async (accountId: number) =>
      (await raw.listTransports(accountId)).map((transport) => transport.addr),
    getConfig: (accountId: number, key: "displayname") => {
      if (key !== "displayname") {
        throw new Error("Unsupported profile configuration read");
      }
      return raw.getConfig(accountId, key);
    },
  }) as CoreRpc;
}
export type CoreEvent = DcEvent;
export type CoreMessage = Awaited<ReturnType<CoreRpc["getMessage"]>>;
export type CoreContact = Awaited<ReturnType<CoreRpc["getContacts"]>>[number];
export interface CoreClient {
  /** Calls are bound to one generation; a lost core rejects, never silently retries writes. */
  use<T>(call: (rpc: CoreRpc) => Promise<T>): Promise<T>;
}
export class CoreUnavailable extends Error {
  constructor() {
    super("Core unavailable");
    this.name = "CoreUnavailable";
  }
}

/** Translate the installed event vocabulary without carrying content into notifications. */
export function publishCoreEvent(hub: ChangeHub, event: CoreEvent): void {
  switch (event.kind) {
    case "IncomingMsg":
    case "MsgsChanged":
    case "MsgDelivered":
    case "MsgFailed":
    case "MsgRead":
      hub.emit({
        type: "messages",
        chatId: event.chatId,
        ids: event.msgId ? [event.msgId] : [],
      });
      hub.emit({ type: "chats" });
      break;
    case "MsgsNoticed":
      hub.emit({ type: "messages", chatId: event.chatId, ids: [] });
      break;
    case "ContactsChanged":
      hub.emit({ type: "contacts" });
      break;
    case "ChatlistChanged":
    case "ChatlistItemChanged":
    case "ChatModified":
      hub.emit({ type: "chats" });
      break;
    case "ConnectivityChanged":
      hub.emit({ type: "connectivity" });
      break;
    case "AccountsChanged":
    case "AccountsItemChanged":
      hub.emit({ type: "account" });
      break;
  }
}
