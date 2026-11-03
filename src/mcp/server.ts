// SPDX-License-Identifier: LGPL-3.0-only
import { McpServer } from "@modelcontextprotocol/server";
import type { ServiceBag } from "../service.ts";
import { status } from "./tools/status.ts";
import { listContacts } from "./tools/list_contacts.ts";
import { listChats } from "./tools/list_chats.ts";
import { readMessages } from "./tools/read_messages.ts";
import { messageStatus } from "./tools/message_status.ts";
import { waitForMessages } from "./tools/wait_for_messages.ts";
import { sendMessage } from "./tools/send_message.ts";
import { deleteMessages } from "./tools/delete_messages.ts";
import { createRoom } from "./tools/create_room.ts";
import { roomTools } from "./room-tools.ts";

export function createMcpServer(
  services?: ServiceBag,
  lifetime = new AbortController().signal,
  subscriptions = false,
) {
  const server = new McpServer({ name: "delta-chat-mcp", version: "0.1.0" }, {
    instructions:
      "This relay owns one Delta Chat identity. Tools see every chat. Start with status and list_contacts. History and bodies belong to core; reading sends receipts but never deletes. Session metadata is routing identity, not authentication. Successful room sends and room_subscribe subscribe/rejoin; only the latest interested subscriber receives new human messages. Subscriptions persist until room_leave. room_resume explicitly resolves a reported anchor discontinuity. Integration inbox controls do not express agent interest. Generic anonymous messaging and wait_for_messages remain available.",
  });
  if (services) {
    status(server, services);
    listContacts(server, services);
    listChats(server, services);
    readMessages(server, services);
    messageStatus(server, services);
    waitForMessages(server, services, lifetime);
    sendMessage(server, services);
    deleteMessages(server, services);
    createRoom(server, services);
    roomTools(server, services, subscriptions);
  }
  return server;
}
