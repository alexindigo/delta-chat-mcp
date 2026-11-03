// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/client";
import { Dispatcher } from "../../integrations/opencode/dispatcher.ts";
import { Inbox } from "../../integrations/opencode/inbox.ts";
import { ModernRelay } from "../../integrations/opencode/modern-relay.ts";
import { OpenCode } from "../../integrations/opencode/opencode.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { Watcher } from "../../integrations/opencode/watcher.ts";
import { routingFixture } from "../room_routing_support.ts";
import { fixture, poll } from "../support.ts";

// Deliver a newer authoritative value at different promise-reaction boundaries.
// The final hint must reach its consumer without a third hint or periodic tick.
async function sweep(
  state: { version: number; seen: number },
  hint: () => void,
) {
  for (let gap = 0; gap <= 24; gap++) {
    state.version++;
    hint();
    for (let i = 0; i < gap; i++) await Promise.resolve();
    state.version++;
    hint();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(state.seen, state.version, `lost final hint at gap ${gap}`);
  }
}

Deno.test("inbox observes the final canonical snapshot across drain settlement", async () => {
  const root = await fixture("inbox-settlement");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const state = { version: 0, seen: -1 };
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: {},
    enabled: true,
  }, () => {
    throw new Error("Injected inbox port must not use a transport");
  });
  relay.identity = () => Promise.resolve("relay@example.invalid");
  relay.scope = async () => ({
    identity: await relay.identity(),
    uri: "deltachat://inbox/coalesced",
  });
  relay.inbox = () => {
    state.seen = state.version;
    return Promise.resolve({ deliveries: [], rooms: [] });
  };
  const inbox = new Inbox({
    registry: () => registry,
    relays: new Map([["relay", relay]]),
    owner: "http://local.invalid/",
    directory: "/project",
    signal: new AbortController().signal,
    opencode: {
      session: () => {
        throw new Error("No bound native target");
      },
      status: () => {
        throw new Error("No bound native target");
      },
    },
    changed() {
      throw new Error("No native admission");
    },
    notify: () => Promise.resolve(),
  });
  try {
    await sweep(state, () => {
      void inbox.sync("relay");
    });
  } finally {
    await inbox.close();
    await relay.close();
    registry.close();
  }
});

Deno.test("accepted dispatcher decisions observe final registry state without another event or backstop", async () => {
  const root = await fixture("dispatcher-settlement");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const state = { version: 0, seen: -1 };
  registry.subscriptions = () => {
    state.seen = state.version;
    return [];
  };
  const dispatcher = new Dispatcher({
    registry: () => registry,
    relays: new Map(),
    opencode: new OpenCode({}),
    owner: "http://local.invalid/",
    directory: "/project",
    holder: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    signal: new AbortController().signal,
  });
  try {
    await sweep(state, () => {
      assertEquals(
        dispatcher.event({
          event: { type: "session.idle", properties: { sessionID: "native" } },
        }),
        "native",
      );
    });
  } finally {
    await dispatcher.close();
    registry.close();
  }
});

Deno.test("legacy watcher observes the final registry snapshot without waiting for its tick", async () => {
  const root = await fixture("watcher-settlement");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const state = { version: 0, seen: -1 };
  registry.subscriptions = () => {
    state.seen = state.version;
    return [];
  };
  const watcher = new Watcher({
    registry: () => registry,
    relays: new Map(),
    owner: "http://local.invalid/",
    directory: "/project",
    holder: crypto.randomUUID(),
    waitSeconds: 1,
    signal: new AbortController().signal,
    changed() {
      throw new Error("No delivery");
    },
    blocked: () => Promise.resolve(),
  });
  try {
    await sweep(state, () => watcher.kick());
  } finally {
    await watcher.close();
    registry.close();
  }
});

Deno.test("modern notification receiver observes its final snapshot across drain settlement", async () => {
  const f = await routingFixture();
  const state = { version: 0, seen: -1 };
  let hint: (() => void) | undefined;
  const original = Client.prototype.setNotificationHandler;
  Client.prototype.setNotificationHandler = function (
    this: Client,
    method: string,
    handler: unknown,
    ...rest: unknown[]
  ) {
    if (
      method === "notifications/resources/updated" &&
      typeof handler === "function"
    ) {
      hint = () =>
        Reflect.apply(handler, this, [{
          method,
          params: {
            uri: `deltachat://inbox/${f.routing.namespace(f.first.id)}`,
          },
        }]);
    }
    return Reflect.apply(original, this, [method, handler, ...rest]);
  };
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  try {
    relay.startReceiver(() => {
      state.seen = state.version;
      return Promise.resolve();
    });
    await poll(() => hint !== undefined && state.seen === 0);
    await sweep(state, () => hint!());
  } finally {
    Client.prototype.setNotificationHandler = original;
    await relay.close();
    await f.close();
  }
});
