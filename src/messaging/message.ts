// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CoreMessage,
  isSelfContact,
  type MessageState,
  messageState,
} from "../core/client.ts";
import { type InlineImage, inlineImage } from "./attachment-policy.ts";
export interface Message {
  id: number;
  chatId: number;
  fromContactId: number;
  fromSelf: boolean;
  text: string;
  timestamp: number;
  state: MessageState;
  hasAttachment: boolean;
  encrypted: boolean;
  attachmentName?: string;
  inlineImage?: InlineImage;
  attachmentDownloadState?: CoreMessage["downloadState"];
}
export function toMessage(message: CoreMessage): Message {
  return {
    id: message.id,
    chatId: message.chatId,
    fromContactId: message.fromId,
    fromSelf: isSelfContact(message.fromId),
    text: message.text,
    timestamp: message.timestamp,
    state: messageState(message.state),
    hasAttachment: message.file !== null || message.fileName !== null,
    encrypted: message.showPadlock,
    ...(message.fileName !== null ? { attachmentName: message.fileName } : {}),
    ...(inlineImage(message) ? { inlineImage: inlineImage(message) } : {}),
    ...(message.downloadState
      ? { attachmentDownloadState: message.downloadState }
      : {}),
  };
}
