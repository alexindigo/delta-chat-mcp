// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { agentResult } from "../agent.ts";
export function listChats(server: McpServer, services: ServiceBag) {
  server.registerTool("list_chats", {
    description:
      "Every chat and room, including contact requests, members and last message time.",
    inputSchema: z.object({ session_id: z.string().min(1).optional() }),
  }, (input, ctx) =>
    agentResult(services, ctx, input, async () => ({
      chats: await services.chats.list(),
    })));
}
