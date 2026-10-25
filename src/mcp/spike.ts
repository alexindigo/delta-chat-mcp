// SPDX-License-Identifier: LGPL-3.0-only
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

/** M0 stateful transport proof. No messaging, auth, or agent state. */
export class SpikeMcp {
  #sessions = new Map<string, {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
  }>();

  get sessionCount() {
    return this.#sessions.size;
  }

  async handleRequest(request: Request): Promise<Response> {
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = this.#sessions.get(id);
      return session
        ? await session.transport.handleRequest(request)
        : Response.json({ error: "Session not found" }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "Session required" }, { status: 400 });
    }

    const server = new McpServer({
      name: "delta-chat-mcp-spike",
      version: "0.0.0",
    });
    server.registerTool("ping", { inputSchema: z.object({}) }, () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.#sessions.set(sessionId, { transport, server });
      },
      // The SDK closes the transport in handleDeleteRequest's finally block.
      onsessionclosed: (sessionId) => {
        this.#sessions.delete(sessionId);
      },
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // Invalid initialization never enters the registry, but must be closed.
      if (!transport.sessionId) await server.close();
    }
  }

  async close() {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map(({ server }) => server.close()));
  }
}
