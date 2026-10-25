// SPDX-License-Identifier: LGPL-3.0-only
import type { RawClient } from "@deltachat/jsonrpc-client";
import type { DcEvent } from "@deltachat/jsonrpc-client";

/** Only the core boundary knows upstream types. Adapters receive services. */
export type CoreRpc = Pick<
  RawClient,
  | "getSystemInfo"
  | "getAllAccountIds"
  | "addAccount"
  | "isConfigured"
  | "setConfig"
  | "getConfig"
  | "addTransportFromQr"
  | "startIo"
  | "getChatSecurejoinQrCode"
  | "createQrSvg"
  | "getConnectivity"
  | "getContacts"
  | "checkQr"
  | "secureJoin"
  | "acceptChat"
  | "blockChat"
  | "createGroupChat"
  | "addContactToChat"
  | "getChatlistEntries"
  | "getChatlistItemsByEntries"
  | "getFullChatById"
  | "getMessageIds"
  | "getMessage"
  | "getMessages"
  | "markseenMsgs"
  | "createChatByContactId"
  | "miscSendTextMessage"
  | "deleteMessages"
>;
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
