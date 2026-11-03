// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ModernRelay } from "../../integrations/opencode/modern-relay.ts";
import { RelayFailure } from "../../integrations/opencode/relay.ts";
import { Proxies, publicTools } from "../../integrations/opencode/proxies.ts";
import { z } from "zod";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { parsePluginOptions } from "../../integrations/opencode/plugin-options.ts";
import { roomMessage, routingFixture } from "../room_routing_support.ts";
import { deadline, fixture, poll } from "../support.ts";

Deno.test("modern standard resource notifications are key scoped, claimed controls recheck ownership, revocation closes only its streams", async () => {
  const f = await routingFixture();
  const clients: Client[] = [];
  const connect = async (key: string) => {
    const c = new Client({ name: "standard-test", version: "1" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL("http://relay.invalid/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
        fetch: f.fetcher,
      }),
    );
    const uri =
      (await c.listResources()).resources.find((r) => r.name === "room-inbox")!
        .uri;
    return { c, uri };
  };
  try {
    const first = await connect(f.first.key),
      second = await connect(f.second.key);
    assertEquals(first.c.getServerCapabilities()?.resources?.subscribe, true);
    const legacy = new Client({ name: "legacy-generic", version: "1" }, {
      versionNegotiation: { mode: "legacy" },
    });
    clients.push(legacy);
    const legacyTransport = new StreamableHTTPClientTransport(
      new URL("http://relay.invalid/mcp"),
      {
        requestInit: { headers: { Authorization: `Bearer ${f.second.key}` } },
        fetch: f.fetcher,
      },
    );
    await legacy.connect(legacyTransport);
    assert(legacyTransport.sessionId);
    // Generic legacy reads/tools remain available; do not advertise a legacy
    // subscription handler that this modern-only notification path does not own.
    assertEquals(
      legacy.getServerCapabilities()?.resources?.subscribe,
      undefined,
    );
    assert(
      (await legacy.readResource({ uri: second.uri })).contents.length > 0,
    );
    assert(first.uri !== second.uri);
    assert(!first.uri.includes(f.first.id));
    assert(!first.uri.includes(f.first.key));
    let hints = 0;
    first.c.setNotificationHandler("notifications/resources/updated", () => {
      hints++;
    });
    const one = await first.c.listen({ resourceSubscriptions: [first.uri] });
    const two = await second.c.listen({ resourceSubscriptions: [second.uri] });
    assertEquals(one.honoredFilter.resourceSubscriptions, [first.uri]);
    await first.c.callTool({
      name: "room_subscribe",
      arguments: { chat_id: 42, session_id: "fallback" },
      _meta: { "ai.opencode/sessionID": "native" },
    });
    assertEquals(
      f.routing.subscriptions(f.first.id, "fallback").subscriptions,
      [],
    );
    assertEquals(
      f.routing.subscriptions(f.first.id, "native").subscriptions.length,
      1,
    );
    f.incoming(roomMessage(11));
    await poll(() =>
      hints > 0 && f.routing.inbox(f.first.id).deliveries.length === 1
    );
    const d = f.routing.inbox(f.first.id).deliveries[0];
    await assertRejects(() => second.c.readResource({ uri: first.uri }));
    const unauthorized = await second.c.callTool({
      name: "inbox_claim",
      arguments: { delivery_id: d.delivery_id, claimant: crypto.randomUUID() },
    });
    assertEquals(unauthorized.isError, true);
    f.access.apiKeys.delete(f.first.id);
    assert(["graceful", "remote"].includes(await deadline(one.closed)));
    await assertRejects(() => first.c.readResource({ uri: first.uri }));
    assert(
      (await second.c.readResource({ uri: second.uri })).contents.length > 0,
    );
    await two.close();
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await f.close();
  }
});

Deno.test("one modern client relistens and catches up after stream loss; send evidence cannot leak to concurrent listen/read", async () => {
  const f = await routingFixture();
  let listens = 0, reads = 0;
  let drop: (() => void) | undefined;
  let rejectSend = false, loseSend = false;
  const methods: string[] = [];
  const toolNames: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    methods.push(body.method);
    if (body.method === "tools/call") toolNames.push(body.params.name);
    if (body.method === "resources/read") reads++;
    if (
      body.method === "tools/call" && body.params.name === "send_message" &&
      rejectSend && body.params.arguments.text === "not dispatched"
    ) {
      return Response.json({ error: "Service closing" }, { status: 503 });
    }
    const response = await f.fetcher(url, init);
    if (
      body.method === "tools/call" && body.params.name === "send_message" &&
      loseSend
    ) {
      await response.arrayBuffer();
      throw new Error("Response lost after core dispatch");
    }
    if (body.method !== "subscriptions/listen") return response;
    listens++;
    const reader = response.body!.getReader();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        drop = () => {
          controller.error(new Error("owned stream loss"));
          void reader.cancel();
        };
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(stream, {
      headers: response.headers,
      status: response.status,
    });
  };
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, fetcher);
  const received: number[][] = [];
  try {
    await relay.rawCall("room_subscribe", { chat_id: 42 }, undefined, "native");
    relay.startReceiver(async () => {
      const inbox = await relay.inbox();
      received.push(inbox.deliveries.flatMap((d) => d.message_ids));
    });
    await poll(() => listens === 1 && reads > 0);
    assertEquals(relay.connectionCount, 1);
    rejectSend = true;
    const rejected = await assertRejects(
      () => relay.send(42, "not dispatched"),
      RelayFailure,
    );
    assertEquals([rejected.kind, rejected.retrySafe], ["closing", true]);
    assertEquals((await relay.inbox()).deliveries.length, 0);
    const concurrent = await Promise.allSettled([
      relay.send(42, "not dispatched"),
      relay.send(42, "accepted alongside"),
      relay.inbox(),
    ]);
    assertEquals(concurrent.map((r) => r.status), [
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    assert(
      concurrent[0].status === "rejected" &&
        concurrent[0].reason instanceof RelayFailure,
    );
    assertEquals(concurrent[0].reason.kind, "closing");
    assertEquals(
      f.sent.filter((s) => s.text === "accepted alongside").length,
      1,
    );
    rejectSend = false;
    loseSend = true;
    const uncertain = await assertRejects(
      () => relay.send(42, "one core post"),
      RelayFailure,
    );
    assertEquals([uncertain.kind, uncertain.retrySafe], ["uncertain", false]);
    assertEquals(f.sent.filter((s) => s.text === "one core post").length, 1);
    drop!();
    f.incoming(roomMessage(13));
    await poll(
      () => listens >= 2 && received.some((ids) => ids.includes(13)),
      10_000,
    );
    assertEquals(relay.connectionCount, 1);
    assert(!toolNames.includes("wait_for_messages"));
    assertEquals(methods.filter((m) => m === "initialize").length, 0);
  } finally {
    await relay.close();
    await f.close();
  }
});

Deno.test("plugin owns configuration and proxy context; paused aliases do no I/O and receiver controls are never model tools", async () => {
  const f = await routingFixture();
  const root = await fixture("modern-proxy");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  let requests = 0;
  const observed: typeof fetch = (url, init) => {
    requests++;
    return f.fetcher(url, init);
  };
  const options = parsePluginOptions({
    relays: {
      relay: {
        url: "http://relay.invalid/mcp",
        headers: { Authorization: `Bearer ${f.first.key}` },
        enabled: true,
      },
      paused: { url: "http://relay.invalid/mcp", enabled: false },
    },
  });
  const relays = new Map(
    options.relays.map((c) => [c.alias, new ModernRelay(c, observed)]),
  );
  const proxies = new Proxies({
    registry: () => registry,
    relays,
    aliases: options.servers,
    owner: "http://local.invalid/",
    directory: "/project",
    signal: new AbortController().signal,
    changed() {},
  });
  try {
    const tools = proxies.tools();
    assert(
      !Object.keys(tools).some((name) =>
        /wait_for_messages|inbox_(claim|complete|release|mirror)/.test(name)
      ),
    );
    const context = { sessionID: "native", ask: () => Promise.resolve() };
    const result = JSON.parse(
      await tools.relay_room_subscribe.execute({
        chat_id: 42,
        session_id: "forged",
      }, context),
    );
    assertEquals(result.structuredContent.session_id, "native");
    assertEquals(
      result.content[0].text,
      JSON.stringify(result.structuredContent),
    );
    assertEquals(
      f.routing.subscriptions(f.first.id, "forged").subscriptions,
      [],
    );
    const before = requests;
    await assertRejects(() => tools.paused_status.execute({}, context));
    assertEquals(requests, before);
    assertEquals(registry.remoteBindings()[0].session, "native");
    assert(!JSON.stringify(registry.remoteBindings()).includes(f.first.key));
  } finally {
    await proxies.close();
    await Promise.all([...relays.values()].map((r) => r.close()));
    registry.close();
    await f.close();
  }
});

Deno.test("unavailable binding storage rejects a native proxy before send dispatch", async () => {
  const f = await routingFixture();
  const toolsCalled: string[] = [];
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, (url, init) => {
    const request = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (request.method === "tools/call") toolsCalled.push(request.params.name);
    return f.fetcher(url, init);
  });
  const proxies = new Proxies({
    aliases: ["relay"],
    relays: new Map([["relay", relay]]),
    registry() {
      throw new Error("Owned unavailable durable storage fixture");
    },
    owner: "http://local.invalid/",
    directory: "/project",
    signal: new AbortController().signal,
    changed() {
      throw new Error("No accepted operation to reconcile");
    },
  });
  try {
    await assertRejects(() =>
      proxies.tools().relay_send_message.execute({
        chat_id: 42,
        text: "must never dispatch",
      }, { sessionID: "native", ask: () => Promise.resolve() })
    );
    assertEquals(toolsCalled, ["status"]);
    assertEquals(f.sent, []);
    assertEquals(f.routing.inbox(f.first.id).deliveries, []);
  } finally {
    await proxies.close();
    await relay.close();
    await f.close();
  }
});

Deno.test("native permission rejection precedes every relay/progress operation", async () => {
  const prompts: unknown[] = [];
  const proxies = new Proxies({
    aliases: ["relay"],
    relays: new Map(),
    registry() {
      throw new Error("Denied request must not access progress");
    },
    owner: "http://local.invalid/",
    directory: "/project",
    signal: new AbortController().signal,
    changed() {},
  });
  try {
    await assertRejects(() =>
      proxies.tools().relay_send_message.execute({
        chat_id: 42,
        text: "denied",
      }, {
        sessionID: "native",
        ask(request: unknown) {
          prompts.push(request);
          return Promise.reject(new Error("rejected permission"));
        },
      })
    );
    assertEquals(prompts, [{
      permission: "relay_send_message",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    }]);
  } finally {
    await proxies.close();
  }
});

Deno.test("dispose cancels a proxy's permission wait without approving it or dispatching after a late native resolution", async () => {
  const lifetime = new AbortController();
  const asked = Promise.withResolvers<void>();
  const permission = Promise.withResolvers<void>();
  const proxies = new Proxies({
    aliases: ["relay"],
    relays: new Map(),
    registry() {
      throw new Error("Cancelled ask must not access progress");
    },
    owner: "http://local.invalid/",
    directory: "/project",
    signal: lifetime.signal,
    changed() {
      throw new Error("Cancelled ask cannot accept an operation");
    },
  });
  const task = proxies.tools().relay_send_message.execute({
    chat_id: 42,
    text: "cancelled",
  }, {
    sessionID: "native",
    ask() {
      asked.resolve();
      return permission.promise;
    },
  });
  try {
    await asked.promise;
    lifetime.abort();
    await assertRejects(() => task);
    await deadline(proxies.close(), 5000);
    permission.resolve();
  } finally {
    lifetime.abort();
    permission.resolve();
    await proxies.close();
  }
});

Deno.test("native proxy schemas preserve the server's optional destination and pagination contracts", () => {
  const send = z.object(publicTools.send_message.args);
  const read = z.object(publicTools.read_messages.args);
  assertEquals(z.toJSONSchema(send).required, ["text"]);
  assertEquals(z.toJSONSchema(read).required, ["chat_id"]);
  assert(send.safeParse({ text: "chat", chat_id: 42 }).success);
  assert(send.safeParse({ text: "contact", contact_id: 20 }).success);
  assert(read.safeParse({ chat_id: 42, after_id: 7 }).success);
  assert(read.safeParse({ chat_id: 42, before_id: 7 }).success);
});

Deno.test("modern relay disposal joins an aborted in-flight send and leaves its uncertain outcome with the caller", async () => {
  const f = await routingFixture();
  const started = Promise.withResolvers<void>();
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, (url, init) => {
    const request = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (
      request.method === "tools/call" && request.params.name === "send_message"
    ) {
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    return f.fetcher(url, init);
  });
  try {
    const outcome = relay.send(42, "interrupted wire request").catch((
      error: unknown,
    ) => error);
    await started.promise;
    await deadline(relay.close(), 5000);
    const error = await outcome;
    assert(error instanceof RelayFailure);
    assertEquals([error.kind, error.retrySafe], ["uncertain", false]);
    assertEquals(relay.connectionCount, 0);
  } finally {
    await relay.close();
    await f.close();
  }
});

Deno.test("claim checks the locally bound target atomically after a recipient change without expressing interest", async () => {
  const f = await routingFixture();
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  try {
    await f.routing.subscribe(f.first.id, "older-directory-session", 42);
    f.incoming(roomMessage(5));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    const observed = f.routing.inbox(f.first.id).deliveries[0];
    await f.routing.subscribe(f.first.id, "new-directory-session", 42);
    const sequence = f.routing.store.read().sequence;
    await assertRejects(() =>
      relay.claim(
        observed.delivery_id,
        crypto.randomUUID(),
        undefined,
        "older-directory-session",
      ), RelayFailure);
    const current = f.routing.inbox(f.first.id).deliveries[0];
    assertEquals([current.state, current.target_session, current.claimant], [
      "ready",
      "new-directory-session",
      null,
    ]);
    const owned = await relay.claim(
      observed.delivery_id,
      crypto.randomUUID(),
      undefined,
      "new-directory-session",
    );
    assertEquals(owned.target_session, "new-directory-session");
    assertEquals(f.routing.store.read().sequence, sequence);
  } finally {
    await relay.close();
    await f.close();
  }
});
