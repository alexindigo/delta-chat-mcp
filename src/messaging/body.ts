// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreMessage, CoreRpc } from "../core/client.ts";
import { decodePlaintextHtml } from "./plaintext-html.ts";

export interface MessageBody {
  text: string;
  textComplete: boolean;
  html?: string;
}

/** Only returned history rows enter here; metadata/presence/receipts never do. */
export async function resolveMessageBody(
  rpc: CoreRpc,
  account: number,
  message: CoreMessage,
): Promise<MessageBody> {
  const downloaded = message.downloadState === "Done";
  if (!message.hasHtml) {
    return { text: message.text, textComplete: downloaded };
  }
  const html = await rpc.getMessageHtml(account, message.id);
  if (html === null) return { text: message.text, textComplete: false };
  const text = decodePlaintextHtml(html);
  if (text !== undefined && downloaded) return { text, textComplete: true };
  return { text: message.text, textComplete: false, html };
}
