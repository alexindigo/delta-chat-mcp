// SPDX-License-Identifier: LGPL-3.0-only
import { McpServer } from "@modelcontextprotocol/server";
import type { ServiceBag } from "../service.ts";
import { status } from "./tools/status.ts";
import { listContacts } from "./tools/list_contacts.ts";
import { listChats } from "./tools/list_chats.ts";
import { readMessages } from "./tools/read_messages.ts";
import { messageStatus } from "./tools/message_status.ts";
import { waitForMessages } from "./tools/wait_for_messages.ts";

export function createMcpServer(
  services?: ServiceBag,
  lifetime = new AbortController().signal,
) {
  const server = new McpServer({ name: "delta-chat-mcp", version: "0.1.0" }, {
    instructions:
      "This relay owns one Delta Chat identity. Tools see every chat. Start with status and list_contacts; create_room can make a fresh session room. Keep the last returned message id yourself and pass it to read_messages or wait_for_messages. History belongs to core and persists across MCP connections. Reading sends read receipts but never deletes. delete_messages removes only this identity's copies. Text only; incoming attachments are described by name. No per-agent cursor or journal is stored.",
  });
  if (services) {
    status(server, services);
    listContacts(server, services);
    listChats(server, services);
    readMessages(server, services);
    messageStatus(server, services);
    waitForMessages(server, services, lifetime);
  }
  return server;
}
