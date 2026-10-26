// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startService } from "../../src/service.ts";
import { loadRuntimeConfig } from "../../src/auth/state.ts";
import { createLog } from "../../src/log.ts";
import { deadline, fixture, lanAddress } from "../support.ts";
import { RoomSetupError } from "../../src/messaging/room-outcome.ts";

Deno.test("product official SDK exposes tools and sanitized identity status over the composed LAN service", async () => {
  const { cfg } = loadRuntimeConfig({
    DCMCP_DATA_DIR: await fixture("mcp-product"),
    DCMCP_LISTEN_PORT: "0",
    DCMCP_AUTH_TYPE: "public",
  });
  const service = await startService(cfg, {
    log: createLog("error", [], () => {}),
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${lanAddress()}:${service.addr.port}/mcp`),
  );
  const client = new Client({ name: "product-offline", version: "0" });
  try {
    await deadline(client.connect(transport));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assertEquals(names.length, 9);
    for (
      const name of [
        "status",
        "list_contacts",
        "list_chats",
        "read_messages",
        "message_status",
        "wait_for_messages",
        "send_message",
        "delete_messages",
        "create_room",
      ]
    ) assert(names.includes(name));
    const result = await client.callTool({ name: "status", arguments: {} });
    assertEquals(result.structuredContent, {
      configured: false,
      accountId: null,
      address: null,
      displayName: null,
      connectivity: null,
    });
    assertEquals(result.content, [{
      type: "text",
      text: JSON.stringify(result.structuredContent),
    }]);
    const invalid = await client.callTool({
      name: "read_messages",
      arguments: { chat_id: 10, limit: 101 },
    });
    assert(invalid.isError);
    const failed = await client.callTool({
      name: "read_messages",
      arguments: { chat_id: 10 },
    });
    assert(failed.isError);
    assertEquals(failed.content, [{
      type: "text",
      text: JSON.stringify(failed.structuredContent),
    }]);
    assert(!JSON.stringify(failed).includes(cfg.data.dir));
    const roomCalls: unknown[] = [];
    service.app.rooms.createRoom = (name, ids) => {
      roomCalls.push(["create", name, ids]);
      return Promise.resolve({ chatId: 99 });
    };
    service.app.rooms.completeRoom = (id, ids) => {
      roomCalls.push(["complete", id, ids]);
      return Promise.resolve({ chatId: id });
    };
    const created = await client.callTool({
      name: "create_room",
      arguments: { name: "Room", contact_ids: [] },
    });
    assertEquals(created.structuredContent, { chat_id: 99 });
    const resumed = await client.callTool({
      name: "create_room",
      arguments: { name: "Room", contact_ids: [42], resume_chat_id: 99 },
    });
    assertEquals(resumed.structuredContent, { chat_id: 99 });
    assertEquals(roomCalls, [["create", "Room", []], ["complete", 99, [42]]]);
    service.app.rooms.createRoom = () =>
      Promise.reject(
        new RoomSetupError({ kind: "uncertain", message: "A room may exist" }),
      );
    const uncertain = await client.callTool({
      name: "create_room",
      arguments: { name: "Room", contact_ids: [] },
    });
    assert(uncertain.isError);
    assertEquals(uncertain.structuredContent, {
      error: "uncertain",
      room: { kind: "uncertain", message: "A room may exist" },
    });
    await transport.terminateSession();
  } finally {
    await client.close();
    await service.close();
  }
});
