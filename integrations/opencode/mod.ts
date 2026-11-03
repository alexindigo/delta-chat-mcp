// SPDX-License-Identifier: LGPL-3.0-only
import { parsePluginOptions, type PluginOptions } from "./plugin-options.ts";
import { OpenCode } from "./opencode.ts";
import { Registry } from "./registry.ts";
import { ModernRelay } from "./modern-relay.ts";
import { openSqlite } from "./sqlite.ts";
import { object, type Subscription } from "./types.ts";
import { Proxies } from "./proxies.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Inbox } from "./inbox.ts";
import { Mirror } from "./mirror.ts";
import { localOwnerProcess } from "./owner-witness.ts";

// Pinned plugin/loader.ts imports every server plugin into the main isolate.
// The capability belongs to that isolate, not an artifact URL's import cache:
// an older copy can still own a delayed prompt after a new copy is imported.
const capabilityKey = Symbol.for("delta-chat-mcp.opencode-wake.process.v1");
if (!Object.hasOwn(globalThis, capabilityKey)) {
  Object.defineProperty(globalThis, capabilityKey, {
    value: Object.freeze({ epoch: crypto.randomUUID() }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
}
const capability = object(
  Object.getOwnPropertyDescriptor(globalThis, capabilityKey)?.value,
);
if (
  typeof capability.epoch !== "string" ||
  !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(capability.epoch)
) throw new Error("Invalid wake process capability");
const epoch = capability.epoch;
export interface Foundation {
  epoch: string;
  directory: string;
  owner: string;
  options: PluginOptions;
  registry: Registry;
  opencode: OpenCode;
  relays: ReadonlyMap<string, ModernRelay>;
  signal: AbortSignal;
  unroutable: ReadonlySet<string>;
  onStop(stop: () => Promise<void>): void;
  onSubscriptionChanged(listener: (row: Subscription) => void): () => void;
}
export interface FoundationPorts {
  attach?(foundation: Foundation): Record<string, unknown>;
}

/** Composition owns lifetime; relay routing and local admission have one owner each. */
export default async function plugin(
  input: unknown,
  options: unknown,
  ports: FoundationPorts = {},
) {
  const value = object(input);
  if (typeof value.directory !== "string" || !value.directory.startsWith("/")) {
    throw new Error("Invalid plugin directory");
  }
  const owner = String(value.serverUrl);
  if (!["http:", "https:"].includes(new URL(owner).protocol)) {
    throw new Error("Invalid OpenCode server URL");
  }
  const parsed = parsePluginOptions(options);
  let registry: Registry | undefined;
  try {
    const db = await openSqlite(parsed.stateFile);
    try {
      registry = new Registry(db);
    } catch (error) {
      db.close();
      throw error;
    }
  } catch {
    /* Tool proxies fail before send if durable admission bindings are unavailable. */
  }
  const lifetime = new AbortController();
  const opencode = new OpenCode(value.client, lifetime.signal);
  const relays = new Map<string, ModernRelay>();
  const unroutable = new Set<string>();
  const consumers: (() => Promise<void>)[] = [];
  const listeners = new Set<(row: Subscription) => void>();
  const foundation: Foundation = {
    epoch,
    directory: value.directory,
    owner,
    options: parsed,
    get registry() {
      if (!registry) throw new Error("Subscription registry unavailable");
      return registry;
    },
    opencode,
    relays,
    signal: lifetime.signal,
    unroutable,
    onStop(stop) {
      consumers.push(stop);
    },
    onSubscriptionChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const holder = crypto.randomUUID();
  const mirror: Mirror = new Mirror({
    registry: () => foundation.registry,
    opencode,
    relays,
    owner,
    directory: foundation.directory,
    epoch,
    signal: lifetime.signal,
    notify: (message) => dispatcher.notify(message),
    sendFinal: (d, text) => inbox.mirror(d, text),
    settled: () => inbox.all(),
    enabled: (alias) => relays.get(alias)?.config.enabled === true,
    transport: (delivery) => inbox.transport(delivery),
  });
  const dispatcher: Dispatcher = new Dispatcher({
    registry: () => foundation.registry,
    opencode,
    relays,
    owner,
    directory: foundation.directory,
    holder,
    epoch,
    process: localOwnerProcess,
    signal: lifetime.signal,
    answerReady: (delivery) => mirror.ready(delivery),
    bodies: (delivery) => inbox.bodies(delivery),
    settled: () => inbox.all(),
    enabled: (alias) => relays.get(alias)?.config.enabled === true,
    enabledDelivery: (delivery) => inbox.ready(delivery),
    transport: (delivery) => inbox.transport(delivery),
  });
  const inbox = new Inbox({
    registry: () => foundation.registry,
    opencode,
    relays,
    owner,
    directory: foundation.directory,
    signal: lifetime.signal,
    changed: (session) => dispatcher.kick(session),
    notify: (message) => dispatcher.notify(message),
  });
  foundation.onStop(() => inbox.close());
  foundation.onStop(() => dispatcher.close());
  foundation.onStop(() => mirror.close());
  foundation.onSubscriptionChanged((row) => {
    inbox.all();
    dispatcher.kick(row.session_id);
  });
  const proxies = new Proxies({
    registry: () => foundation.registry,
    directory: foundation.directory,
    owner,
    aliases: parsed.servers,
    relays,
    signal: lifetime.signal,
    changed: () => inbox.all(),
    prepareSend: (alias, scope, args, context) =>
      mirror.prepareSend(alias, scope, args, context),
    settleSend: (attempts, result, error) =>
      mirror.settleSend(attempts, result, error),
    notify: (message) => dispatcher.notify(message),
  });
  foundation.onStop(() => proxies.close());
  const attached = ports.attach?.(foundation) ?? {};
  let startup: ReturnType<typeof setTimeout> | undefined;
  return {
    ...attached,
    tool: {
      ...proxies.tools(),
      ...(attached.tool as Record<string, unknown> ?? {}),
    },
    async "tool.execute.after"(input: unknown, output: unknown) {
      // v1 plugin execute returns a string; its after-hook has {output:string}.
      // Decode the unchanged MCP envelope for real running-part self-send proof.
      try {
        const value = object(output);
        await mirror.observe(
          input,
          typeof value.output === "string" ? JSON.parse(value.output) : output,
        );
      } catch { /* observation never changes an accepted tool result */ }
    },
    event(input: unknown) {
      if (dispatcher.event(input) !== undefined) inbox.all();
      if (typeof attached.event === "function") attached.event(input);
    },
    config(_config: unknown) {
      if (disposed) return;
      // Plugin options own enable/pause and credentials. Native MCP config is
      // deliberately not consulted. Each loaded instance configures once.
      for (const server of parsed.relays) {
        if (relays.has(server.alias)) continue;
        relays.set(
          server.alias,
          new ModernRelay(server),
        );
      }
      // Never await our own directory's API while config/init owns bootstrap.
      // The first consumer request is scheduled only after this hook returns.
      clearTimeout(startup);
      startup = setTimeout(() => {
        if (disposed) return;
        inbox.start();
        dispatcher.all();
        mirror.all();
      }, 0);
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      const completion = Promise.withResolvers<void>();
      // Publish before abort listeners can re-enter disposal.
      disposal = completion.promise;
      void (async () => {
        disposed = true;
        clearTimeout(startup);
        dispatcher.fence();
        lifetime.abort();
        const stopped = await Promise.allSettled(
          consumers.map((stop) => stop()),
        );
        listeners.clear();
        try {
          await Promise.all([...relays.values()].map((relay) => relay.close()));
        } finally {
          registry?.close();
        }
        if (stopped.some((r) => r.status === "rejected")) {
          throw new Error("Integration consumer shutdown failed");
        }
      })().then(completion.resolve, completion.reject);
      return disposal;
    },
  };
}
