// SPDX-License-Identifier: LGPL-3.0-only
import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { ServiceBag } from "../service.ts";
import { McpSessions } from "./sessions.ts";
import { createMcpServer } from "./server.ts";
import { inboxUri } from "../messaging/room-routing.ts";

/** Legacy session ownership stays intact. Modern streams belong to one verified
 * key's handler, so revocation closes precisely that key's active exchanges. */
export class McpTransport {
  #legacy: McpSessions;
  #modern = new Map<string, McpHttpHandler>();
  #closing = false;
  #stops = new Set<Promise<void>>();
  #off: () => void;
  #offUpdates: () => void;
  /** Actual delegated legacy sessions; modern handlers/subscribers are separate. */
  get legacySessionCount() {
    return this.#legacy.sessionCount;
  }
  constructor(private readonly services: ServiceBag) {
    this.#legacy = new McpSessions(
      services.apiKeys,
      (signal, owner) =>
        createMcpServer({ ...services, mcpOwner: owner ?? "public" }, signal),
    );
    this.#off = services.apiKeys.subscribeRevoked((id) => {
      const handler = this.#modern.get(id);
      this.#modern.delete(id);
      if (handler) {
        const task = handler.close();
        this.#stops.add(task);
        void task.then(
          () => this.#stops.delete(task),
          () => {
            // Retain failed revocation cleanup for the composition's close gate.
          },
        );
      }
      services.routing?.kick();
    });
    this.#offUpdates = services.routing?.subscribeUpdates((uri) => {
      for (const [owner, handler] of this.#modern) {
        const namespace = services.routing?.store.read().namespaces.find((n) =>
          n.owner === owner
        );
        if (namespace && uri === inboxUri(namespace.id)) {
          handler.notify.resourceUpdated(uri);
        }
      }
    }) ?? (() => {});
  }
  async handleRequest(request: Request, owner?: string): Promise<Response> {
    if (this.#closing) {
      return Response.json({ error: "Service closing" }, { status: 503 });
    }
    if (owner !== undefined && !this.services.apiKeys.has(owner)) {
      return Response.json({ error: "Bearer key required" }, {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }
    if (await isLegacyRequest(request)) {
      return await this.#legacy.handleRequest(request, owner);
    }
    // Recheck after the asynchronous body classification/revocation race.
    if (this.#closing) {
      return Response.json({ error: "Service closing" }, { status: 503 });
    }
    if (owner !== undefined && !this.services.apiKeys.has(owner)) {
      return Response.json({ error: "Bearer key required" }, { status: 401 });
    }
    const key = owner ?? "public";
    let handler = this.#modern.get(key);
    if (!handler) {
      handler = createMcpHandler(
        () =>
          createMcpServer({ ...this.services, mcpOwner: key }, undefined, true),
        { legacy: "reject" },
      );
      this.#modern.set(key, handler);
    }
    return await handler.fetch(request);
  }
  async close() {
    this.#closing = true;
    this.#off();
    this.#offUpdates();
    const results = await Promise.allSettled([
      this.#legacy.close(),
      ...[...this.#modern.values()].map((h) => h.close()),
      ...this.#stops,
    ]);
    this.#modern.clear();
    if (results.some((r) => r.status === "rejected")) {
      throw new Error("MCP shutdown failed");
    }
  }
}
