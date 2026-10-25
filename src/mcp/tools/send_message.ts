// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { toolResult } from "../result.ts";
export function sendMessage(server: McpServer, services: ServiceBag) {
  server.registerTool("send_message", {
    description:
      "Send exact text to a chat OR contact. The first room text delivers its invitation to members.",
    inputSchema: z.object({
      chat_id: z.number().int().positive().optional(),
      contact_id: z.number().int().positive().optional(),
      text: z.string().min(1),
    }).refine(
      (input) =>
        (input.chat_id === undefined) !== (input.contact_id === undefined),
      "Choose exactly one chat_id or contact_id",
    ),
  }, (input) =>
    toolResult(async () => {
      const sent = input.chat_id !== undefined
        ? await services.send.sendText(input.chat_id, input.text)
        : await services.send.sendTextToContact(input.contact_id!, input.text);
      return {
        message_id: sent.messageId,
        chat_id: sent.chatId,
        state: sent.state,
      };
    }));
}
