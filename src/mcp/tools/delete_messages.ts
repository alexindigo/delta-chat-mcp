// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { agentResult } from "../agent.ts";
export function deleteMessages(server: McpServer, services: ServiceBag) {
  server.registerTool("delete_messages", {
    description:
      "Delete copies from this relay identity only. Never deletes peers' messages.",
    inputSchema: z.object({
      session_id: z.string().min(1).optional(),
      message_ids: z.array(z.number().int().positive()).max(100),
    }),
  }, (input, ctx) =>
    agentResult(services, ctx, input, async () => {
      await services.delete.deleteMessages(input.message_ids);
      return { deleted_ids: [...new Set(input.message_ids)] };
    }));
}
