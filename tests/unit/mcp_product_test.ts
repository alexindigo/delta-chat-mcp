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
    for (
      const name of [
        "status",
        "list_contacts",
        "list_chats",
        "read_messages",
        "message_status",
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
    assert(!JSON.stringify(failed).includes(cfg.data.dir));
    await transport.terminateSession();
  } finally {
    await client.close();
    await service.close();
  }
});
