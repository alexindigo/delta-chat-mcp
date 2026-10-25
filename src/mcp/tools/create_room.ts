// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { toolResult } from "../result.ts";
export function createRoom(server: McpServer, services: ServiceBag) {
  server.registerTool(
    "create_room",
    {
      description:
        "Create a fresh named room with the selected contacts. Send the first text to deliver the room to peers.",
      inputSchema: z.object({
        name: z.string().trim().min(1),
        contact_ids: z.array(z.number().int().positive()).max(100),
      }),
    },
    (input) =>
      toolResult(async () => ({
        chat_id:
          (await services.rooms.createRoom(input.name, input.contact_ids))
            .chatId,
      })),
  );
}
