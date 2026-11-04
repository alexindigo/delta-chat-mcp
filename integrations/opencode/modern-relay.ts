// SPDX-License-Identifier: LGPL-3.0-only
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { RelayConfiguration } from "./options.ts";
import { RelayFailure, type RelayHealth } from "./relay.ts";
import {
  object,
  positiveID,
  relayMessage,
  type RelayScope,
  relayScope,
  sameRelayScope,
} from "./types.ts";

export const inboxDelivery = z.object({
  delivery_id: z.string().uuid(),
  target_session: z.string().min(1),
  chat_id: positiveID,
  from_anchor: positiveID.nullable(),
  message_ids: z.array(positiveID).min(1),
  state: z.enum(["ready", "claimed", "completed"]),
  claimant: z.string().nullable(),
  outcome: z.string().nullable(),
  mirror: z.enum(["none", "attempting", "sent", "uncertain"]),
  mirror_message_id: positiveID.nullable(),
});
export type RemoteDelivery = z.infer<typeof inboxDelivery>;
export const remoteClaim = inboxDelivery.extend({
  claim_token: z.string().uuid(),
});
export type RemoteClaim = z.infer<typeof remoteClaim>;
const attemptKey = "chat.delta/attempt";
interface Evidence {
  started: boolean;
  rejection?: "auth_failed" | "closing";
  expected?: RelayScope;
  guarded?: boolean;
}
interface Connection {
  client: Client;
  lifetime: AbortController;
  uri: string;
}
export function payload(result: unknown): Record<string, unknown> {
  const value = object(result);
  if (value.isError) {
    let reason:
      | "not_found"
      | "core_unavailable"
      | "cancelled"
      | "request_failed" = "request_failed";
    try {
      reason = z.enum([
        "not_found",
        "core_unavailable",
        "cancelled",
        "request_failed",
      ]).catch("request_failed").parse(object(value.structuredContent).error);
    } catch { /* sanitized */ }
    throw new RelayFailure("tool_error", false, reason, "application");
  }
  if (value.structuredContent !== undefined) {
    return object(value.structuredContent);
  }
  const text = z.array(
    z.object({ type: z.string(), text: z.string().optional() }),
  ).parse(value.content).find((c) => c.type === "text")?.text;
  return object(JSON.parse(text ?? "null"));
}

/** One modern client per alias for tools, reads AND listen. HTTP evidence is
 * scoped to an individual tools/call, never connection-wide stream state. */
export class ModernRelay {
  #connection?: Connection;
  #connecting?: Promise<Connection>;
  #lifetime = new AbortController();
  #evidence = new Map<string, Evidence>();
  #jobs = new Set<Promise<unknown>>();
  #listeners = new Set<() => void>();
  #receiver?: Promise<void>;
  #health: RelayHealth = { state: "disconnected", retryAt: 0 };
  #closing?: Promise<void>;
  #cleanupFailures = 0;
  #terminal = false;
  #retiring = false;
  #validated?: { connection: Connection; scope: RelayScope };
  constructor(
    readonly config: RelayConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  get health(): RelayHealth {
    return this.config.enabled
      ? { ...this.#health }
      : { state: "paused", retryAt: 0 };
  }
  get connectionCount() {
    return this.#connection ? 1 : 0;
  }
  get connectingCount() {
    return this.#connecting ? 1 : 0;
  }
  get cleanupFailures() {
    return this.#cleanupFailures;
  }
  refreshNativeState() {
    return Promise.resolve(
      this.config.enabled && !this.#lifetime.signal.aborted,
    );
  }
  matchesScope(scope: RelayScope) {
    return this.config.enabled && !this.#lifetime.signal.aborted &&
      !!this.#validated && this.#validated.connection === this.#connection &&
      !this.#validated.connection.lifetime.signal.aborted &&
      sameRelayScope(this.#validated.scope, scope);
  }
  async #scope(c: Connection, signal?: AbortSignal): Promise<RelayScope> {
    this.#guard();
    try {
      // Authentication can change independently of identity. Validate the
      // current resource namespace, not a cached address or mutable alias.
      const resources = await c.client.listResources({}, {
        signal: this.#signal(signal),
        cacheMode: "bypass",
      });
      const inboxes = resources.resources.filter((r) =>
        r.name === "room-inbox"
      );
      const status = payload(
        await c.client.callTool({ name: "status", arguments: {} }, {
          signal: this.#signal(signal),
          timeout: 30_000,
        }),
      );
      if (inboxes.length !== 1) {
        throw new RelayFailure("paused", false, undefined, "guard");
      }
      const scope = relayScope.parse({
        identity: status.address,
        uri: inboxes[0].uri,
      });
      if (
        scope.uri !== c.uri || this.#connection !== c ||
        c.lifetime.signal.aborted
      ) {
        this.#validated = undefined;
        throw new RelayFailure("paused", false, undefined, "guard");
      }
      this.#guard();
      this.#validated = { connection: c, scope };
      return scope;
    } catch (error) {
      if (error instanceof RelayFailure) throw error;
      throw new RelayFailure("pre_dispatch", true);
    }
  }
  scope(signal?: AbortSignal, expected?: RelayScope) {
    return this.#own(async () => {
      const c = await this.#connect(), scope = await this.#scope(c, signal);
      if (expected && !sameRelayScope(scope, expected)) {
        throw new RelayFailure("paused", false, undefined, "guard");
      }
      return scope;
    });
  }
  async #expected(
    c: Connection,
    expected: RelayScope | undefined,
    signal?: AbortSignal,
  ) {
    if (expected && !sameRelayScope(await this.#scope(c, signal), expected)) {
      throw new RelayFailure("paused", false, undefined, "guard");
    }
    this.#guard();
    if (c !== this.#connection || c.lifetime.signal.aborted) {
      throw new RelayFailure("pre_dispatch", true);
    }
  }
  #signal(signal?: AbortSignal) {
    return AbortSignal.any([
      this.#lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
  }
  #guard() {
    if (this.#terminal) {
      throw new RelayFailure("paused", false, undefined, "guard");
    }
    if (this.#retiring) {
      throw new RelayFailure("pre_dispatch", true, undefined, "guard");
    }
    if (this.#lifetime.signal.aborted) {
      throw new RelayFailure("cancelled", false, undefined, "guard");
    }
    if (!this.config.enabled) {
      throw new RelayFailure("paused", false, undefined, "guard");
    }
  }
  #own<T>(action: () => Promise<T>) {
    const task = action();
    this.#jobs.add(task);
    void task.finally(() => this.#jobs.delete(task)).catch(() => {});
    return task;
  }
  async #connect(): Promise<Connection> {
    this.#guard();
    if (this.#connection) return this.#connection;
    if (this.#connecting) return await this.#connecting;
    this.#connecting = (async () => {
      const client = new Client({
        name: "delta-chat-mcp-opencode",
        version: "1",
      }, {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      });
      const lifetime = new AbortController();
      client.onclose = () => lifetime.abort();
      const signal = this.#signal(lifetime.signal);
      // Install BEFORE listen, including the acknowledgement/read gap.
      client.setNotificationHandler("notifications/resources/updated", () => {
        for (const listener of this.#listeners) listener();
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
        {
          requestInit: { headers: this.config.headers, redirect: "error" },
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 60_000,
            reconnectionDelayGrowFactor: 2,
          },
          fetch: async (url, init) => {
            let evidence: Evidence | undefined;
            let method: string | undefined;
            try {
              const body = typeof init?.body === "string"
                ? JSON.parse(init.body)
                : undefined;
              method = body?.method;
              if (body?.method === "tools/call") {
                evidence = this.#evidence.get(body.params?._meta?.[attemptKey]);
              }
            } catch { /* unknown framing gives no pre-dispatch proof */ }
            if (method && !method.startsWith("notifications/")) {
              try {
                this.#guard();
                if (
                  evidence?.expected && !this.matchesScope(evidence.expected)
                ) throw new RelayFailure("paused", false, undefined, "guard");
              } catch (error) {
                if (evidence && !evidence.started) evidence.guarded = true;
                throw error;
              }
            }
            if (evidence) evidence.started = true;
            const response = await this.fetcher(url, {
              ...init,
              signal: AbortSignal.any([
                signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            });
            if (evidence && [401, 503].includes(response.status)) {
              try {
                const error = object(await response.clone().json()).error;
                if (
                  response.status === 401 && error === "Bearer key required"
                ) {
                  evidence.rejection = "auth_failed";
                }
                if (response.status === 503 && error === "Service closing") {
                  evidence.rejection = "closing";
                }
              } catch { /* unknown response is uncertain */ }
            }
            return response;
          },
        },
      );
      try {
        await client.connect(transport, { signal, timeout: 15_000 });
        const resources = await client.listResources({}, {
          signal,
          cacheMode: "bypass",
        });
        const inbox = resources.resources.filter((r) =>
          r.name === "room-inbox"
        );
        if (inbox.length !== 1) throw new Error("Inbox resource unavailable");
        this.#guard();
        const c = { client, lifetime, uri: inbox[0].uri };
        this.#connection = c;
        this.#health = { state: "connected", retryAt: 0 };
        return c;
      } catch {
        lifetime.abort();
        try {
          await client.close();
        } catch {
          this.#cleanupFailures++;
          this.#terminal = true;
          this.#health = {
            state: "disconnected",
            retryAt: 0,
            reason: "receiver_cleanup_failed",
          };
        }
        throw new RelayFailure("pre_dispatch", true);
      }
    })();
    try {
      return await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }
  rawCall(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    session?: string,
    expected?: RelayScope,
  ) {
    return this.#own(async () => {
      this.#guard();
      const c = await this.#connect();
      await this.#expected(c, expected, signal);
      const key = crypto.randomUUID();
      const evidence: Evidence = { started: false, expected };
      this.#evidence.set(key, evidence);
      try {
        return await c.client.callTool({
          name,
          arguments: args,
          _meta: {
            [attemptKey]: key,
            ...(session ? { "ai.opencode/sessionID": session } : {}),
          },
        }, { signal: this.#signal(signal), timeout: 30_000 });
      } catch {
        if (evidence.guarded && !evidence.started) {
          throw new RelayFailure("paused", false, undefined, "guard");
        }
        if (evidence.rejection) {
          throw new RelayFailure(evidence.rejection, true);
        }
        // No message matching this call reached fetch: no dispatch. Every other
        // failure (including cancellation) conservatively remains uncertain.
        throw new RelayFailure(
          evidence.started ? "uncertain" : "pre_dispatch",
          !evidence.started,
        );
      } finally {
        this.#evidence.delete(key);
      }
    });
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    session?: string,
    expected?: RelayScope,
  ) {
    return payload(await this.rawCall(name, args, signal, session, expected));
  }
  async identity(signal?: AbortSignal) {
    return z.object({ address: z.string().min(1) }).parse(
      await this.call("status", {}, signal),
    ).address;
  }
  /** Read-only advertised schemas, shared by native channel tool adapters. */
  catalog(signal?: AbortSignal) {
    return this.#own(async () => {
      const c = await this.#connect();
      await this.#expected(c, undefined, signal);
      return (await c.client.listTools({}, {
        signal: this.#signal(signal),
        cacheMode: "bypass",
      })).tools;
    });
  }
  async read(
    chat_id: number,
    after_id?: number,
    signal?: AbortSignal,
    before_id?: number,
    expected?: RelayScope,
  ) {
    return z.object({ messages: z.array(relayMessage) }).parse(
      await this.call(
        "read_messages",
        {
          chat_id,
          ...(after_id ? { after_id } : {}),
          ...(before_id ? { before_id } : {}),
          limit: 100,
        },
        signal,
        undefined,
        expected,
      ),
    );
  }
  async send(
    chat_id: number,
    text: string,
    signal?: AbortSignal,
    expected?: RelayScope,
  ) {
    return z.object({
      message_id: positiveID,
      chat_id: positiveID,
      state: z.string(),
    }).parse(
      await this.call(
        "send_message",
        { chat_id, text },
        signal,
        undefined,
        expected,
      ),
    );
  }
  inbox(signal?: AbortSignal, expected?: RelayScope) {
    return this.#own(async () => {
      this.#guard();
      const c = await this.#connect();
      await this.#expected(c, expected, signal);
      const raw = await c.client.readResource({ uri: c.uri }, {
        signal: this.#signal(signal),
        cacheMode: "bypass",
      });
      const data = raw.contents.find((r) => "text" in r);
      if (!data || !("text" in data)) throw new Error("Invalid inbox resource");
      return z.object({
        deliveries: z.array(inboxDelivery),
        rooms: z.array(z.object({
          chat_id: positiveID,
          state: z.string(),
          anchor_id: positiveID.nullable(),
        })),
      }).parse(JSON.parse(data.text));
    });
  }
  async claim(
    id: string,
    claimant: string,
    signal?: AbortSignal,
    targetSession?: string,
    expected?: RelayScope,
  ) {
    return remoteClaim.parse(
      await this.call(
        "inbox_claim",
        { delivery_id: id, claimant },
        signal,
        targetSession,
        expected,
      ),
    );
  }
  bodies(
    id: string,
    token: string,
    signal?: AbortSignal,
    expected?: RelayScope,
  ) {
    return this.#own(async () => {
      this.#guard();
      try {
        const c = await this.#connect();
        await this.#expected(c, expected, signal);
        const raw = await c.client.readResource({
          uri: `${c.uri}/delivery/${encodeURIComponent(id)}/${
            encodeURIComponent(token)
          }`,
        }, { signal: this.#signal(signal), cacheMode: "bypass" });
        const data = raw.contents.find((r) => "text" in r);
        if (!data || !("text" in data)) {
          throw new Error("Invalid delivery resource");
        }
        return z.object({ messages: z.array(relayMessage) }).parse(
          JSON.parse(data.text),
        );
      } catch (error) {
        // Repeatable body-read failures defer this room without reserving another
        // room's native slot. They never fabricate absence/source_deleted.
        if (error instanceof RelayFailure) throw error;
        throw new RelayFailure("uncertain", false);
      }
    });
  }
  /** A single owner reconnects/relistens. The caller's dirty drain closes races. */
  startReceiver(
    changed: () => Promise<void>,
    signal?: AbortSignal,
    notify?: (message: string) => Promise<void>,
  ) {
    if (this.#receiver) return;
    const combined = this.#signal(signal);
    this.#receiver = (async () => {
      if (this.#terminal) {
        await notify?.(
          `delta-chat-mcp: relay ${this.config.alias} receiver_cleanup_failed; receiver stopped because prior ownership could not be proven settled.`,
        );
        return;
      }
      let failures = 0;
      while (!combined.aborted && this.config.enabled && !this.#terminal) {
        let c: Connection | undefined;
        let subscription: Awaited<ReturnType<Client["listen"]>> | undefined;
        let drain: Promise<void> | undefined;
        let dirty = false, acknowledged = false;
        const reading = new AbortController();
        let retrySleep: AbortController | undefined;
        const hint = () => {
          dirty = true;
          // A hint wakes only the owned retry delay, never the shared client or
          // subscription. Abort also cancels the superseded timer.
          retrySleep?.abort();
          if (!acknowledged || drain || combined.aborted) return;
          drain = Promise.resolve().then(async () => {
            try {
              let readFailures = 0;
              while (dirty && !combined.aborted && !reading.signal.aborted) {
                dirty = false;
                try {
                  await changed();
                  readFailures = 0;
                  this.#health = { state: "connected", retryAt: 0 };
                } catch {
                  if (
                    combined.aborted || reading.signal.aborted ||
                    c?.lifetime.signal.aborted
                  ) break;
                  // A hint received during the failed read is already fresh work.
                  if (dirty) continue;
                  // A failed request is not evidence that the shared client is
                  // invalid. One owned retry retains hints and unrelated sends.
                  dirty = true;
                  const wait = Math.min(
                    60_000,
                    1000 * 2 ** Math.min(readFailures++, 6),
                  );
                  this.#health = {
                    state: "connected",
                    retryAt: Date.now() + wait,
                    reason: "reconciliation_retry",
                  };
                  const sleep = new AbortController();
                  retrySleep = sleep;
                  try {
                    await delay(wait, undefined, {
                      signal: AbortSignal.any([
                        combined,
                        reading.signal,
                        sleep.signal,
                        ...(c ? [c.lifetime.signal] : []),
                      ]),
                    });
                  } catch (error) {
                    if (!sleep.signal.aborted) throw error;
                  } finally {
                    if (retrySleep === sleep) retrySleep = undefined;
                  }
                }
              }
            } finally {
              // Notification hints cannot be stranded during promise settlement.
              drain = undefined;
            }
          });
          void drain.catch(() => {}); // cancellation belongs to the receiver
        };
        this.#listeners.add(hint);
        let cleanupError: unknown;
        try {
          c = await this.#connect();
          subscription = await c.client.listen({
            resourceSubscriptions: [c.uri],
          }, {
            signal: AbortSignal.any([combined, c.lifetime.signal]),
            timeout: 15_000,
          });
          const honored = subscription.honoredFilter.resourceSubscriptions;
          if (!honored?.includes(c.uri)) {
            throw new Error("Inbox subscription not honored");
          }
          acknowledged = true;
          failures = 0;
          hint();
          await subscription.closed;
        } catch {
          /* canonical inbox catches up on re-listen */
        } finally {
          // Fence new operations before the first asynchronous cleanup attempt.
          // No proxy can create a replacement while old ownership is unknown.
          this.#retiring = true;
          acknowledged = false;
          retrySleep?.abort();
          reading.abort();
          this.#listeners.delete(hint);
          // Cleanup failures must not skip cancellation/join of the read owner.
          try {
            await subscription?.close();
          } catch (error) {
            this.#cleanupFailures++;
            cleanupError = error;
            this.#terminal = true;
          }
          await drain?.catch(() => {});
          if (c && this.#connection === c) {
            this.#connection = undefined;
            c.lifetime.abort();
            try {
              await c.client.close();
            } catch (error) {
              this.#cleanupFailures++;
              cleanupError ??= error;
              this.#terminal = true;
            }
          }
          await Promise.allSettled([...this.#jobs]);
          this.#retiring = false;
        }
        if (cleanupError || this.#terminal) {
          this.#terminal = true;
          this.#validated = undefined;
          this.#health = {
            state: "disconnected",
            retryAt: 0,
            reason: "receiver_cleanup_failed",
          };
          await notify?.(
            `delta-chat-mcp: relay ${this.config.alias} receiver_cleanup_failed; receiver stopped because prior ownership could not be proven settled. Reload only after inspecting the relay.`,
          );
          throw new Error("Modern relay cleanup failed");
        }
        if (!combined.aborted) {
          this.#health = {
            state: "disconnected",
            retryAt: Date.now() +
              Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)),
          };
          try {
            await delay(
              Math.max(1, this.#health.retryAt - Date.now()),
              undefined,
              {
                signal: combined,
              },
            );
          } catch {
            break;
          }
        }
      }
    })();
    void this.#receiver.catch(() => {
      if (!this.#terminal) this.#health = { state: "disconnected", retryAt: 0 };
    });
  }
  close() {
    this.#lifetime.abort();
    return this.#closing ??= (async () => {
      const stopped = await Promise.allSettled([this.#receiver]);
      await this.#connecting?.catch(() => {});
      this.#connection?.lifetime.abort();
      const closed = await Promise.allSettled([
        this.#connection?.client.close(),
      ]);
      // Operation errors belong to their callers (notably an aborted send's
      // uncertain result). Join them without treating cancellation as failed
      // transport cleanup.
      await Promise.allSettled([...this.#jobs]);
      this.#connection = undefined;
      if (
        this.#cleanupFailures ||
        [...stopped, ...closed].some((r) => r.status === "rejected")
      ) {
        throw new Error("Modern relay shutdown failed");
      }
    })();
  }
}
