// SPDX-License-Identifier: LGPL-3.0-only
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { RelayConfiguration } from "./options.ts";
import { object, positiveID, relayMessage } from "./types.ts";

export type RelayFailureKind =
  | "paused"
  | "auth_failed"
  | "session_expired"
  | "closing"
  | "pre_dispatch"
  | "uncertain"
  | "cancelled"
  | "tool_error";
export type RelayFailureDomain = "guard" | "application" | "transport";
export class RelayFailure extends Error {
  cleanupFailures = 0;
  constructor(
    readonly kind: RelayFailureKind,
    readonly retrySafe: boolean,
    readonly reason?:
      | "not_found"
      | "core_unavailable"
      | "cancelled"
      | "request_failed",
    readonly domain: RelayFailureDomain = "transport",
  ) {
    super(`Relay ${kind}`);
    this.name = "RelayFailure";
  }
}
export class RelayShutdownFailure extends Error {
  constructor(readonly failures: number) {
    super(`Relay shutdown failed (${failures} cleanup failures)`);
    this.name = "RelayShutdownFailure";
  }
}
const guard = (kind: RelayFailureKind, safe = false) =>
  new RelayFailure(kind, safe, undefined, "guard");
interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  lifetime: AbortController;
  busy: boolean;
  toolStarted: boolean;
  rejection?: "auth_failed" | "session_expired" | "closing";
  terminationBenign?: boolean;
  closing?: Promise<void>;
}
const resultPayload = (input: unknown, name: string) => {
  const result = object(input);
  if (result.isError) {
    const reason = z.enum([
      "not_found",
      "core_unavailable",
      "cancelled",
      "request_failed",
    ]).catch("request_failed").parse(
      object(result.structuredContent ?? {}).error,
    );
    throw new RelayFailure(
      name === "send_message" ? "uncertain" : "tool_error",
      false,
      reason,
      "application",
    );
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = z.array(
    z.object({ type: z.string(), text: z.string().optional() }),
  ).parse(result.content);
  const text = content.find((c) => c.type === "text")?.text;
  if (text === undefined) throw new RelayFailure("uncertain", false);
  return JSON.parse(text) as unknown;
};
export interface RelayGate {
  enabled(alias: string): Promise<boolean>;
}
export interface RelayHealth {
  state: "disconnected" | "connected" | "paused" | "auth_failed";
  retryAt: number;
  reason?: "receiver_cleanup_failed" | "reconciliation_retry";
}

/** Sole connection owner. Each checked-out MCP connection has one operation,
 * so HTTP evidence cannot leak between a long wait and a simultaneous mirror.
 * The SDK is fixed to legacy initialization and never retries tool sends here. */
export class Relay {
  #connections = new Set<Connection>();
  #connecting = new Set<Promise<Connection>>();
  #closed = false;
  #failures = 0;
  #health: RelayHealth = { state: "disconnected", retryAt: 0 };
  #waitMax?: number;
  #identity?: string;
  #cleanupFailures = 0;
  #closing?: Promise<void>;
  constructor(
    readonly config: RelayConfiguration,
    private readonly gate: RelayGate,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly createClient: () => Client = () =>
      new Client({ name: "delta-chat-mcp-opencode", version: "1" }, {
        versionNegotiation: { mode: "legacy" },
      }),
  ) {}
  get health(): RelayHealth {
    return { ...this.#health };
  }
  get cleanupFailures(): number {
    return this.#cleanupFailures;
  }
  get connectionCount(): number {
    return this.#connections.size;
  }
  get connectingCount(): number {
    return this.#connecting.size;
  }
  async refreshNativeState(): Promise<boolean> {
    const enabled = await this.gate.enabled(this.config.alias);
    if (!enabled) {
      this.#health = { state: "paused", retryAt: 0 };
      await this.#disconnect();
      return false;
    }
    if (this.#health.state === "paused") {
      this.#health = { state: "disconnected", retryAt: 0 };
    }
    return true;
  }
  async #connect(signal?: AbortSignal): Promise<Connection> {
    const c: Connection = {
      client: this.createClient(),
      transport: undefined as unknown as StreamableHTTPClientTransport,
      lifetime: new AbortController(),
      busy: true,
      toolStarted: false,
    };
    c.transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers: this.config.headers, redirect: "error" },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 60_000,
        reconnectionDelayGrowFactor: 2,
      },
      fetch: async (url, init) => {
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined;
        const tool = body?.method === "tools/call";
        if (tool) {
          c.toolStarted = true;
          c.rejection = undefined;
        }
        const response = await this.fetcher(url, {
          ...init,
          signal: AbortSignal.any([
            c.lifetime.signal,
            ...(init?.signal ? [init.signal] : []),
            ...(init?.method === "DELETE" ? [AbortSignal.timeout(2000)] : []),
          ]),
        });
        if (tool && [401, 403, 404, 503].includes(response.status)) {
          // Only the characterized relay route's exact pre-dispatch rejections.
          // Unknown proxies/errors, response loss and fetch exception messages
          // are never interpreted as proof of non-dispatch.
          let error: unknown;
          try {
            error = object(await response.clone().json()).error;
          } catch { /* uncertain */ }
          if (response.status === 401 && error === "Bearer key required") {
            c.rejection = "auth_failed";
          }
          if (
            response.status === 404 && error === "Session not found" &&
            c.transport.sessionId
          ) c.rejection = "session_expired";
          if (response.status === 503 && error === "Service closing") {
            c.rejection = "closing";
          }
        }
        if (init?.method === "DELETE") {
          c.terminationBenign = [401, 403, 404, 405].includes(response.status);
          if (response.status === 503) {
            try {
              c.terminationBenign =
                object(await response.clone().json()).error ===
                  "Service closing";
            } catch {
              /* An uncharacterized cleanup failure must be reported. */
            }
          }
        } else if ([401, 403].includes(response.status)) {
          this.#health = { state: "auth_failed", retryAt: 0 };
        }
        return response;
      },
    });
    this.#connections.add(c);
    try {
      const combined = AbortSignal.any([
        c.lifetime.signal,
        ...(signal ? [signal] : []),
      ]);
      await c.client.connect(c.transport, {
        signal: combined,
        timeout: 15_000,
      });
      const catalog = await c.client.listTools({}, {
        signal: combined,
        timeout: 15_000,
      });
      const wait = catalog.tools.find((tool) =>
        tool.name === "wait_for_messages"
      );
      const maximum =
        object(object(wait?.inputSchema).properties).timeout_seconds;
      this.#waitMax = positiveID.parse(object(maximum).maximum);
      return c;
    } catch (error) {
      // No tools/call was issued. Preserve the operation classification even if
      // cleanup itself fails; close() separately reports all shutdown failures.
      const failure = this.#health.state === "auth_failed"
        ? new RelayFailure("auth_failed", true)
        : error instanceof RelayFailure
        ? error
        : new RelayFailure("pre_dispatch", true);
      await this.#cleanupAfterFailure(c, failure);
      throw failure;
    }
  }
  async #checkout(
    attempt: { started: boolean },
    signal?: AbortSignal,
    fresh = false,
  ): Promise<Connection> {
    signal?.throwIfAborted();
    if (this.#closed) throw guard("cancelled");
    if (!await this.refreshNativeState()) throw guard("paused");
    if (this.#closed) throw guard("cancelled");
    if (this.#health.state === "auth_failed") throw guard("auth_failed", true);
    if (this.now() < this.#health.retryAt) throw guard("pre_dispatch", true);
    // A send never trusts a warm session's historical handshake. Its fresh
    // initialization/catalog establish the characterized pre-dispatch boundary.
    const existing = fresh
      ? undefined
      : [...this.#connections].find((c) => !c.busy);
    if (existing) {
      existing.busy = true;
      return existing;
    }
    attempt.started = true;
    const connecting = this.#connect(signal);
    this.#connecting.add(connecting);
    try {
      const c = await connecting;
      if (this.#closed || this.#health.state === "paused") {
        const failure = guard(this.#closed ? "cancelled" : "paused");
        await this.#cleanupAfterFailure(c, failure);
        throw failure;
      }
      return c;
    } finally {
      this.#connecting.delete(connecting);
    }
  }
  async #drop(c: Connection, terminate = false) {
    return await (c.closing ??= (async () => {
      this.#identity = undefined;
      c.busy = true;
      this.#connections.delete(c);
      let failures = 0;
      if (terminate && c.transport.sessionId) {
        try {
          await c.transport.terminateSession();
        } catch {
          if (!c.terminationBenign) failures++;
        }
      }
      c.lifetime.abort();
      try {
        await c.client.close();
      } catch {
        failures++;
      }
      this.#cleanupFailures += failures;
      if (failures) throw new RelayShutdownFailure(failures);
    })());
  }
  async #cleanupAfterFailure(c: Connection, failure: RelayFailure) {
    try {
      await this.#drop(c, true);
    } catch (error) {
      failure.cleanupFailures += error instanceof RelayShutdownFailure
        ? error.failures
        : 1;
    }
  }
  async #disconnect() {
    const results = await Promise.allSettled(
      [...this.#connections].map((c) => this.#drop(c, true)),
    );
    if (results.some((r) => r.status === "rejected")) {
      throw new RelayShutdownFailure(this.#cleanupFailures);
    }
  }
  #backoff(connected: boolean) {
    if (
      this.#closed || ["paused", "auth_failed"].includes(this.#health.state)
    ) return;
    this.#health = {
      state: connected ? "connected" : "disconnected",
      retryAt: this.now() +
        Math.min(60_000, 1000 * 2 ** Math.min(this.#failures++, 6)),
    };
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let c: Connection | undefined;
    const attempt = { started: false };
    const isolatedSend = name === "send_message";
    try {
      c = await this.#checkout(attempt, signal, isolatedSend);
      c.toolStarted = false;
      c.rejection = undefined;
      const combined = AbortSignal.any([
        c.lifetime.signal,
        ...(signal ? [signal] : []),
      ]);
      const seconds = name === "wait_for_messages"
        ? Math.min(positiveID.parse(args.timeout_seconds), this.#waitMax!)
        : 0;
      combined.throwIfAborted();
      attempt.started = true;
      const result = await c.client.callTool({
        name,
        arguments: {
          ...args,
          ...(seconds ? { timeout_seconds: seconds } : {}),
        },
      }, {
        signal: combined,
        timeout: seconds ? (seconds + 15) * 1000 : 30_000,
      });
      const payload = resultPayload(result, name);
      c.busy = false;
      if (
        !this.#closed && !["paused", "auth_failed"].includes(this.#health.state)
      ) {
        this.#failures = 0;
        this.#health = { state: "connected", retryAt: 0 };
      }
      if (isolatedSend) {
        // A known accepted result must never become a retry suggestion because
        // disposal failed. Keep it intact; health/close expose cleanup failure.
        try {
          await this.#drop(c, true);
        } catch (error) {
          if (!(error instanceof RelayShutdownFailure)) this.#cleanupFailures++;
        }
      }
      return payload;
    } catch (error) {
      const rejection = c?.rejection;
      const failure = rejection
        ? new RelayFailure(rejection, true)
        : error instanceof RelayFailure && error.domain === "application"
        ? error
        : name === "send_message" && c?.toolStarted &&
            (signal?.aborted || this.#closed || this.#health.state === "paused")
        ? new RelayFailure("uncertain", false)
        : this.#health.state === "paused"
        ? guard("paused")
        : signal?.aborted || this.#closed
        ? guard("cancelled")
        : error instanceof RelayFailure
        ? error
        : !attempt.started
        ? guard("pre_dispatch", true)
        : new RelayFailure("uncertain", false);
      if (error instanceof RelayShutdownFailure) {
        failure.cleanupFailures += error.failures;
      }
      if (error instanceof RelayFailure && error !== failure) {
        failure.cleanupFailures += error.cleanupFailures;
      }
      if (failure.domain === "application") {
        // A complete MCP error result proves a live session, not a broken
        // transport. Anchor errors belong to the watcher; core outages back off
        // without discarding the healthy MCP connection.
        if (c) c.busy = false;
        if (failure.reason === "core_unavailable") this.#backoff(true);
        else if (
          !this.#closed &&
          !["paused", "auth_failed"].includes(this.#health.state)
        ) {
          this.#health = { ...this.#health, state: "connected" };
        }
        if (isolatedSend && c) await this.#cleanupAfterFailure(c, failure);
      } else {
        if (c) {
          if (
            !isolatedSend && failure.domain === "guard" && !c.toolStarted &&
            !this.#closed &&
            this.#health.state !== "paused"
          ) {
            c.busy = false;
          } else await this.#cleanupAfterFailure(c, failure);
        }
        if (attempt.started && failure.domain === "transport") {
          this.#backoff(false);
        }
      }
      throw failure;
    }
  }
  async identity(signal?: AbortSignal): Promise<string> {
    const cached = this.#identity;
    if (cached !== undefined) {
      if (!await this.refreshNativeState()) throw guard("paused");
      // Another operation can close its isolated connection while the native
      // guard awaits HTTP, invalidating this shared cache. Revalidate instead of
      // returning an invalidated (or replaced) field to routing consumers.
      if (this.#identity === cached) return cached;
    }
    const address = z.object({ address: z.string().min(1) }).parse(
      await this.call("status", {}, signal),
    ).address;
    this.#identity = address;
    return address;
  }
  async wait(
    chat_id: number,
    after_id: number,
    seconds: number,
    signal?: AbortSignal,
  ) {
    return z.object({
      timedOut: z.boolean(),
      messages: z.array(relayMessage).max(100),
    }).parse(
      await this.call("wait_for_messages", {
        chat_id: positiveID.parse(chat_id),
        after_id: positiveID.parse(after_id),
        timeout_seconds: positiveID.parse(seconds),
      }, signal),
    );
  }
  async read(
    chat_id: number,
    after_id?: number,
    signal?: AbortSignal,
    before_id?: number,
  ) {
    if (after_id !== undefined && before_id !== undefined) {
      throw new Error("Choose one history direction");
    }
    return z.object({ messages: z.array(relayMessage).max(100) }).parse(
      await this.call("read_messages", {
        chat_id: positiveID.parse(chat_id),
        ...(after_id ? { after_id: positiveID.parse(after_id) } : {}),
        ...(before_id ? { before_id: positiveID.parse(before_id) } : {}),
        limit: 100,
      }, signal),
    );
  }
  async send(chat_id: number, text: string, signal?: AbortSignal) {
    return z.object({
      message_id: positiveID,
      chat_id: positiveID,
      state: z.string(),
    }).parse(
      await this.call("send_message", {
        chat_id: positiveID.parse(chat_id),
        text: z.string().parse(text),
      }, signal),
    );
  }
  async close() {
    this.#closed = true;
    return await (this.#closing ??= (async () => {
      await Promise.allSettled([
        this.#disconnect(),
        ...this.#connecting,
      ]);
      if (this.#cleanupFailures) {
        throw new RelayShutdownFailure(this.#cleanupFailures);
      }
    })());
  }
}
