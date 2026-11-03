// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { agentResult } from "../agent.ts";
export function status(server: McpServer, services: ServiceBag) {
  server.registerTool(
    "status",
    {
      description: "Relay identity and connectivity.",
      inputSchema: z.object({ session_id: z.string().min(1).optional() }),
    },
    (input, ctx) =>
      agentResult(services, ctx, input, () => services.account.status()),
  );
}
