// SPDX-License-Identifier: LGPL-3.0-only
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

/** Real SDK wire transport; no Delta Chat identities or live relay calls. */
export class McpFixture {
  readonly token = crypto.randomUUID();
  readonly calls: Record<string, unknown>[] = [];
  holding = false;
  #release?: () => void;
  #hold?: Promise<void>;
  readonly url: string;
  readonly #http: Deno.HttpServer<Deno.NetAddr>;
  readonly #sessions = new Map<string, {
    server: McpServer;
    transport: WebStandardStreamableHTTPServerTransport;
  }>();

  constructor() {
    this.#http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        const id = request.headers.get("mcp-session-id");
        if (id) {
          const session = this.#sessions.get(id);
          return session
            ? await session.transport.handleRequest(request)
            : new Response("Unknown session", { status: 404 });
        }
        if (request.method !== "POST") {
          return new Response("Session required", { status: 400 });
        }
        const server = new McpServer({
          name: "j0-wire-fixture",
          version: "0.0.0",
        });
        server.registerTool("send_message", {
          inputSchema: z.object({
            text: z.string(),
            mode: z.string().optional(),
          }),
          description: "J0 local wire fixture",
        }, async (args) => {
          this.calls.push(args);
          if (args.mode === "hold") {
            if (!this.#hold) throw new Error("Fixture hold was not armed");
            this.holding = true;
            await this.#hold;
            this.holding = false;
          }
          if (args.mode === "error") {
            return {
              isError: true,
              content: [{ type: "text", text: "fixture-error" }],
            };
          }
          const result = {
            message_id: 100 + this.calls.length,
            chat_id: 42,
            state: "sent",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            this.#sessions.set(id, { server, transport });
          },
          onsessionclosed: (id) => {
            this.#sessions.delete(id);
          },
        });
        await server.connect(transport);
        try {
          return await transport.handleRequest(request);
        } finally {
          if (!transport.sessionId) await server.close();
        }
      },
    );
    this.url = `http://127.0.0.1:${this.#http.addr.port}/mcp`;
  }

  holdNext() {
    if (this.#release) throw new Error("Fixture hold already armed");
    const latch = Promise.withResolvers<void>();
    this.#hold = latch.promise;
    this.#release = latch.resolve;
    return () => {
      latch.resolve();
      this.#release = undefined;
      this.#hold = undefined;
    };
  }

  async close() {
    this.#release?.();
    await Promise.all(
      [...this.#sessions.values()].map(({ server }) => server.close()),
    );
    this.#sessions.clear();
    await this.#http.shutdown();
  }
}
