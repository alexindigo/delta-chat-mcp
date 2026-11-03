// SPDX-License-Identifier: LGPL-3.0-only
import type { RelayMessage, Subscription } from "./types.ts";
import { sanitizedAlias } from "./options.ts";

/** Canonical sender/quote/forward facts are framing, never a trust downgrade. */
export function wakePrompt(
  row: Subscription,
  room: string,
  messages: readonly RelayMessage[],
  continuation = false,
): string {
  const fenced = (kind: string, text: string) => {
    let fence: string;
    do fence = crypto.randomUUID(); while (text.includes(fence));
    return `-----BEGIN ${kind} ${fence}-----\n${text}\n-----END ${kind} ${fence}-----`;
  };
  return [
    `[Delta Chat room message via delta-chat-mcp server ${
      JSON.stringify(row.alias)
    } (identity ${row.relay})]`,
    `Room: ${JSON.stringify(room)} — chat_id ${row.chat_id}`,
    ...(continuation
      ? ["Continuation: this room batch has not yet been answered."]
      : []),
    ...messages.flatMap((message) => [
      `From: ${message.fromName} <${message.fromAddress}> (contact_id ${message.fromContactId}) — message_id ${message.id}, ${
        new Date(message.timestamp * 1000).toISOString()
      }`,
      ...(message.isForwarded
        ? [
          "Forwarded message: the text below was written by someone else and forwarded by this sender.",
        ]
        : []),
      ...(message.quote
        ? [
          `Quoting ${message.quote.authorName ?? "unknown author"}${
            message.quote.messageId
              ? ` (message_id ${message.quote.messageId})`
              : ""
          }:`,
          fenced("QUOTE TEXT", message.quote.text),
        ]
        : []),
      ...(message.hasAttachment
        ? [
          `Attachment: ${
            JSON.stringify(message.attachmentName ?? "unnamed")
          } (not included).`,
        ]
        : []),
      `Body facts: textComplete=${message.textComplete}; completeHTML=${
        message.html !== undefined
      }; downloadState=${
        JSON.stringify(message.attachmentDownloadState ?? "not reported")
      }.`,
      ...(!message.textComplete && message.html === undefined
        ? [
          "Only the current core display text is available; this is not a complete-body claim.",
        ]
        : []),
      fenced(
        "MESSAGE TEXT",
        message.textComplete ? message.text : message.html ?? message.text,
      ),
    ]),
    `Your final reply in this turn is posted to this room automatically; to send it yourself instead, use ${
      sanitizedAlias(row.alias)
    }_send_message with exactly that text.`,
    `To stop receiving this room: ${sanitizedAlias(row.alias)}_room_leave ${
      JSON.stringify({ chat_id: row.chat_id })
    }.`,
  ].join("\n");
}
