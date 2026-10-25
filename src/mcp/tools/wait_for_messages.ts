// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { toolResult } from "../result.ts";
export function waitForMessages(
  server: McpServer,
  services: ServiceBag,
  lifetime: AbortSignal,
) {
  server.registerTool(
    "wait_for_messages",
    {
      description:
        "Wait for up to 100 newer messages in core history. Returns immediately if present, otherwise waits within the configured deadline. Returned incoming messages are marked seen.",
      inputSchema: z.object({
        chat_id: z.number().int().positive(),
        after_id: z.number().int().positive(),
        timeout_seconds: z.number().int().min(1).max(
          services.cfg.mcp.waitMaxSeconds,
        ).default(Math.min(120, services.cfg.mcp.waitMaxSeconds)),
      }),
    },
    (input, ctx) =>
      toolResult(async () =>
        await services.chats.waitAndRead(
          input.chat_id,
          input.after_id,
          input.timeout_seconds * 1000,
          AbortSignal.any([lifetime, ctx.mcpReq.signal]),
        )
      ),
  );
}
