// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { toolResult } from "../result.ts";
export function status(server: McpServer, services: ServiceBag) {
  server.registerTool("status", {
    description: "Relay identity and connectivity.",
    inputSchema: z.object({}),
  }, () => toolResult(() => services.account.status()));
}
