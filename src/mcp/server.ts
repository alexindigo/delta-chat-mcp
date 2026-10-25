// SPDX-License-Identifier: LGPL-3.0-only
import { McpServer } from "@modelcontextprotocol/server";

export function createMcpServer() {
  return new McpServer({ name: "delta-chat-mcp", version: "0.1.0" }, {
    instructions:
      "This relay owns one Delta Chat identity. Tools see every chat. Start with status and list_contacts; create_room can make a fresh session room. Keep the last returned message id yourself and pass it to read_messages or wait_for_messages. History belongs to core and persists across MCP connections. Reading sends read receipts but never deletes. delete_messages removes only this identity's copies. Text only; incoming attachments are described by name. No per-agent cursor or journal is stored.",
  });
}
