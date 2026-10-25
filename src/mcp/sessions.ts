// SPDX-License-Identifier: LGPL-3.0-only
import {
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { ApiKeys } from "../auth/api-keys.ts";
import { createMcpServer } from "./server.ts";

interface Session {
  owner: string | undefined;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lifetime: AbortController;
  touched: number;
  closed?: Promise<void>;
}

/** Session IDs route transport state; only a freshly verified Bearer grants access. */
export class McpSessions {
  #sessions = new Map<string, Session>();
  #all = new Set<Session>();
  #closing?: Promise<void>;
  #off: () => void;
  #timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly keys: ApiKeys,
    private readonly build: (signal: AbortSignal) => McpServer =
      createMcpServer,
    private readonly idleMs = 30 * 60_000,
  ) {
    this.#off = keys.subscribeRevoked((id) => {
      for (const session of this.#all) {
        if (session.owner === id) void this.#close(session);
      }
    });
    this.#timer = setInterval(() => {
      for (const session of this.#all) {
        if (Date.now() - session.touched >= this.idleMs) {
          void this.#close(session);
        }
      }
    }, Math.min(idleMs, 60_000));
  }
  get sessionCount() {
    return this.#sessions.size;
  }
  #close(session: Session): Promise<void> {
    session.lifetime.abort();
    if (session.transport.sessionId) {
      this.#sessions.delete(session.transport.sessionId);
    }
    return session.closed ??= session.server.close().finally(() => {
      this.#all.delete(session);
    });
  }
  async handleRequest(request: Request, owner?: string): Promise<Response> {
    if (this.#closing) {
      return Response.json({ error: "Service closing" }, { status: 503 });
    }
    // Closes the authenticate→initialization race without treating a session id as auth.
    if (owner !== undefined && !this.keys.has(owner)) {
      return Response.json({ error: "Bearer key required" }, {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = this.#sessions.get(id);
      if (!session || session.owner !== owner) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      session.touched = Date.now();
      return await session.transport.handleRequest(request);
    }
    if (request.method !== "POST") {
      return Response.json({ error: "Session required" }, { status: 400 });
    }
    const lifetime = new AbortController();
    const server = this.build(lifetime.signal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        if (!lifetime.signal.aborted) this.#sessions.set(id, session);
      },
      onsessionclosed: () => {
        void this.#close(session);
      },
    });
    const session: Session = {
      owner,
      server,
      transport,
      lifetime,
      touched: Date.now(),
    };
    this.#all.add(session);
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      if (!transport.sessionId || lifetime.signal.aborted) {
        await this.#close(session);
      }
    }
  }
  close(): Promise<void> {
    if (!this.#closing) {
      clearInterval(this.#timer);
      this.#off();
      this.#closing = Promise.all(
        [...this.#all].map((session) => this.#close(session)),
      ).then(() => {});
    }
    return this.#closing;
  }
}
