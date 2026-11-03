// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CoreMessage,
  isSelfContact,
  type MessageState,
  messageState,
} from "../core/client.ts";
import { type InlineImage, inlineImage } from "./attachment-policy.ts";
import type { MessageBody } from "./body.ts";
export interface Message extends MessageBody {
  id: number;
  chatId: number;
  fromContactId: number;
  fromSelf: boolean;
  fromName: string;
  fromAddress: string;
  isInfo: boolean;
  isBot: boolean;
  isForwarded: boolean;
  quote?: { text: string; messageId?: number; authorName?: string };
  timestamp: number;
  state: MessageState;
  hasAttachment: boolean;
  encrypted: boolean;
  attachmentName?: string;
  inlineImage?: InlineImage;
  attachmentDownloadState?: CoreMessage["downloadState"];
}
export function toMessage(message: CoreMessage, body: MessageBody): Message {
  return {
    id: message.id,
    chatId: message.chatId,
    fromContactId: message.fromId,
    fromSelf: isSelfContact(message.fromId),
    ...body,
    fromName: message.overrideSenderName ?? message.sender.displayName,
    fromAddress: message.sender.address,
    isInfo: message.isInfo,
    isBot: message.isBot,
    isForwarded: message.isForwarded,
    ...(message.quote
      ? {
        quote: {
          text: message.quote.text,
          ...(message.quote.kind === "WithMessage"
            ? {
              messageId: message.quote.messageId,
              authorName: message.quote.overrideSenderName ??
                message.quote.authorDisplayName,
            }
            : {}),
        },
      }
      : {}),
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
