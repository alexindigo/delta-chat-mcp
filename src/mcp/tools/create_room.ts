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
        "Create a fresh named room with selected encryption-usable contacts. Send the first text to deliver it to peers. On an incomplete result, explicitly resume the SAME unpromoted chat with resume_chat_id; never blindly retry an uncertain creation.",
      inputSchema: z.object({
        name: z.string().trim().min(1),
        contact_ids: z.array(z.number().int().positive()).max(100),
        resume_chat_id: z.number().int().positive().max(0xffffffff).optional(),
      }),
    },
    (input) =>
      toolResult(async () => ({
        chat_id: (await (input.resume_chat_id === undefined
          ? services.rooms.createRoom(input.name, input.contact_ids)
          : services.rooms.completeRoom(
            input.resume_chat_id,
            input.contact_ids,
          )))
          .chatId,
      })),
  );
}
