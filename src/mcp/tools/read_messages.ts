// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { agentResult } from "../agent.ts";
export function readMessages(server: McpServer, services: ServiceBag) {
  server.registerTool(
    "read_messages",
    {
      description:
        "Read core history oldest first. Sends receipts only for returned incoming messages; never deletes. Choose after_id OR before_id.",
      inputSchema: z.object({
        session_id: z.string().min(1).optional(),
        chat_id: z.number().int().positive(),
        after_id: z.number().int().positive().optional(),
        before_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }).refine(
        (input) =>
          input.after_id === undefined || input.before_id === undefined,
        "Choose after_id or before_id",
      ),
    },
    (input, ctx) =>
      agentResult(services, ctx, input, async () => ({
        messages: await services.chats.readMessages(input.chat_id, {
          afterId: input.after_id,
          beforeId: input.before_id,
          limit: input.limit,
        }),
      })),
  );
}
