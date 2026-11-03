// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { agentResult } from "../agent.ts";
export function messageStatus(server: McpServer, services: ServiceBag) {
  server.registerTool(
    "message_status",
    {
      description:
        "Batch delivery/read state, or not_found for removed messages.",
      inputSchema: z.object({
        session_id: z.string().min(1).optional(),
        message_ids: z.array(z.number().int().positive()).max(100),
      }),
    },
    (input, ctx) =>
      agentResult(services, ctx, input, async () => ({
        messages: await services.send.status(input.message_ids),
      })),
  );
}
