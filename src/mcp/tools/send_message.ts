// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { agentResult, sessionID } from "../agent.ts";
export function sendMessage(server: McpServer, services: ServiceBag) {
  server.registerTool("send_message", {
    description:
      "Send exact text to a chat OR contact. The first room text delivers its invitation to members.",
    inputSchema: z.object({
      session_id: z.string().min(1).optional(),
      chat_id: z.number().int().positive().optional(),
      contact_id: z.number().int().positive().optional(),
      text: z.string().min(1),
    }).refine(
      (input) =>
        (input.chat_id === undefined) !== (input.contact_id === undefined),
      "Choose exactly one chat_id or contact_id",
    ),
  }, (input, ctx) =>
    agentResult(services, ctx, input, async () => {
      const sent = input.chat_id !== undefined
        ? await services.send.sendText(input.chat_id, input.text)
        : await services.send.sendTextToContact(input.contact_id!, input.text);
      let routing: Record<string, unknown> | undefined;
      const session = sessionID(ctx, input);
      if (session && services.routing) {
        // A routing/storage failure cannot turn an accepted send into a retry.
        try {
          if ((await services.chats.get(sent.chatId)).type === "Group") {
            routing = await services.routing.subscribe(
              services.mcpOwner ?? "public",
              session,
              sent.chatId,
              sent.messageId,
            );
          }
        } catch {
          routing = { error: "subscription_not_recorded" };
        }
      }
      return {
        message_id: sent.messageId,
        chat_id: sent.chatId,
        state: sent.state,
        ...(routing ? { routing } : {}),
      };
    }));
}
