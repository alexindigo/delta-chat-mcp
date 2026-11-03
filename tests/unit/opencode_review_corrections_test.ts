// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Inbox } from "../../integrations/opencode/inbox.ts";
import { ModernRelay } from "../../integrations/opencode/modern-relay.ts";
import { Proxies } from "../../integrations/opencode/proxies.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { RelayFailure } from "../../integrations/opencode/relay.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { Client } from "@modelcontextprotocol/client";
import { Mirror } from "../../integrations/opencode/mirror.ts";
import {
  type NativeMessage,
  object,
} from "../../integrations/opencode/types.ts";
import { OpenCode } from "../../integrations/opencode/opencode.ts";
import { Dispatcher } from "../../integrations/opencode/dispatcher.ts";
import { localOwnerProcess } from "../../integrations/opencode/owner-witness.ts";
import { roomMessage, routingFixture } from "../room_routing_support.ts";
import { deadline, fixture, poll } from "../support.ts";

Deno.test("review F1 rejected prepared A intent cannot strand reassigned B in a shared registry across projects", async () => {
  const f = await routingFixture(), root = await fixture("review-shared");
  const aDB = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const bDB = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const sendHeld = Promise.withResolvers<void>(),
    releaseSend = Promise.withResolvers<void>();
  let sendAborted = false, listens = 0;
  const make = (alias: string, key: string) =>
    new ModernRelay({
      alias,
      url: "http://relay.invalid/mcp",
      headers: { Authorization: `Bearer ${key}` },
      enabled: true,
    }, async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (alias === "a" && body.method === "subscriptions/listen") listens++;
      if (alias === "a" && body.params?.name === "send_message") {
        const response = await f.fetcher(url, init);
        sendHeld.resolve();
        init?.signal?.addEventListener("abort", () => {
          sendAborted = true;
        }, { once: true });
        await releaseSend.promise;
        if (init?.signal?.aborted) throw new Error("held send aborted");
        return response;
      }
      if (alias === "a" && body.params?.name === "inbox_claim") {
        held.resolve();
        await release.promise;
      }
      return f.fetcher(url, init);
    });
  const a = make("a", f.first.key), b = make("b", f.second.key);
  const received: string[] = [];
  const nativeInputs: {
    session: string;
    text: string;
    delivery: string;
    message: string;
  }[] = [];
  const project = (alias: string, relay: ModernRelay, registry: Registry) => {
    const lifetime = new AbortController();
    const ports = {
      registry: () => registry,
      relays: new Map([[alias, relay]]),
      owner: "http://local.invalid/",
      directory: `/${alias}`,
      signal: lifetime.signal,
    };
    const rows: NativeMessage[] = [{
      info: {
        id: "msg_seed",
        role: "user",
        agent: "selected",
        model: { providerID: "fixture", modelID: "model" },
        time: { created: 1 },
      },
      parts: [{ id: "prt_seed", type: "text", text: "native seed" }],
    }];
    const opencode = new OpenCode({
      session: {
        get: () =>
          Promise.resolve({
            data: {
              id: alias,
              agent: "selected",
              model: { id: "model", providerID: "fixture" },
            },
          }),
        status: () => Promise.resolve({ data: {} }),
        messages: () => Promise.resolve({ data: rows }),
        message: (input: unknown) => {
          const row = rows.find((r) =>
            r.info.id === object(object(input).path).messageID
          );
          return Promise.resolve(
            row
              ? { data: row }
              : { response: new Response(null, { status: 404 }) },
          );
        },
        promptAsync: (input: unknown) => {
          const body = object(object(input).body),
            part = object((body.parts as unknown[])[0]);
          const id = String(
            object(object(part.metadata).deltaChatWake).deliveryId,
          );
          assertEquals(registry.submissions(id)[0].message_id, body.messageID);
          assertEquals(registry.submissions(id)[0].part_id, part.id);
          nativeInputs.push({
            session: alias,
            text: String(part.text),
            delivery: id,
            message: String(body.messageID),
          });
          rows.push({
            info: {
              id: String(body.messageID),
              role: "user",
              time: { created: 2 },
            },
            parts: [{
              id: String(part.id),
              type: "text",
              text: String(part.text),
              metadata: object(part.metadata),
            }],
          }, {
            info: {
              id: "msg_answer",
              role: "assistant",
              parentID: String(body.messageID),
              finish: "stop",
              time: { created: 3, completed: 4 },
            },
            parts: [{ id: "prt_answer", type: "text", text: "final" }],
          });
          return Promise.resolve({
            response: new Response(null, { status: 204 }),
          });
        },
      },
      tui: { showToast: () => Promise.resolve({ data: {} }) },
    }, lifetime.signal);
    const inbox = new Inbox({
      ...ports,
      opencode,
      changed(session) {
        received.push(session);
        dispatcher.kick(session);
      },
      notify: () => Promise.resolve(),
    });
    const dispatcher = new Dispatcher({
      ...ports,
      opencode,
      holder: crypto.randomUUID(),
      epoch: crypto.randomUUID(),
      process: localOwnerProcess,
      bodies: (d) => inbox.bodies(d),
      enabledDelivery: (d) => inbox.ready(d),
      transport: (d) => inbox.transport(d),
    });
    const proxies = new Proxies({ ...ports, aliases: [alias], changed() {} });
    return { inbox, proxies, dispatcher, lifetime };
  };
  const A = project("a", a, aDB), B = project("b", b, bDB);
  let pending: Promise<void> | undefined;
  let sent: Promise<unknown> | undefined;
  try {
    await A.proxies.tools().a_room_subscribe.execute({ chat_id: 42 }, {
      sessionID: "a",
      ask: () => Promise.resolve(),
    });
    await B.proxies.tools().b_room_subscribe.execute({ chat_id: 42 }, {
      sessionID: "b",
      ask: () => Promise.resolve(),
    });
    f.routing.interest(f.first.id, "a", 42);
    A.inbox.start();
    await poll(() => listens === 1);
    sent = A.proxies.tools().a_send_message.execute({
      chat_id: 42,
      text: "held actual model send",
    }, { sessionID: "a", ask: () => Promise.resolve() }).catch((e) => e);
    await deadline(sendHeld.promise);
    f.incoming(roomMessage(17));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    pending = A.inbox.sync("a").catch(() => {});
    await deadline(held.promise);
    f.routing.interest(f.second.id, "b", 42);
    release.resolve();
    await pending;
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(sendAborted, false);
    releaseSend.resolve();
    const result = JSON.parse(await sent as string);
    assert(result.structuredContent.message_id > 0);
    assertEquals(listens, 1);
    assertEquals(aDB.deliveries(), []);
    await B.inbox.sync("b");
    assertEquals(received, ["b"]);
    const d = bDB.deliveries()[0];
    await poll(() => nativeInputs.length === 1);
    assertEquals(nativeInputs[0].session, "b");
    assertEquals(nativeInputs[0].delivery, d.id);
    assert(nativeInputs[0].text.includes("body-17"));
    assertEquals(d.session_id, "b");
    assertEquals((await B.inbox.bodies(d))?.map((m) => m.id), [17]);
    assertEquals(aDB.deliveryEdge(d.id)?.uri, (await b.scope()).uri);
    await A.inbox.sync("a");
    await B.inbox.sync("b");
    assertEquals(bDB.deliveries().length, 1);
    await Promise.all([A.dispatcher.close(), B.dispatcher.close()]);
    assertEquals(nativeInputs.length, 1);
    assertEquals(bDB.submissions(d.id).length, 1);
  } finally {
    release.resolve();
    releaseSend.resolve();
    await pending;
    await sent;
    A.lifetime.abort();
    B.lifetime.abort();
    await Promise.all([
      A.inbox.close(),
      B.inbox.close(),
      A.proxies.close(),
      B.proxies.close(),
      A.dispatcher.close(),
      B.dispatcher.close(),
    ]);
    await Promise.all([a.close(), b.close()]);
    aDB.close();
    bDB.close();
    await f.close();
  }
});

Deno.test("review F3 cleanup failure is visibly terminal and cannot create a duplicate receiver or client", async () => {
  const f = await routingFixture();
  const original = Client.prototype.listen;
  let listens = 0, reads = 0, requests = 0;
  const cleanupStarted = Promise.withResolvers<void>(),
    releaseCleanup = Promise.withResolvers<void>();
  const notices: string[] = [];
  Client.prototype.listen = async function (...args) {
    const subscription = await original.apply(this, args);
    listens++;
    return {
      ...subscription,
      close: async () => {
        await subscription.close();
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        throw new Error("owned cleanup failure");
      },
    };
  };
  const relay = new ModernRelay({
    alias: "a",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, (url, init) => {
    requests++;
    return f.fetcher(url, init);
  });
  try {
    relay.startReceiver(
      async () => {
        reads++;
        await relay.inbox();
      },
      undefined,
      (message) => {
        notices.push(message);
        return Promise.resolve();
      },
    );
    await poll(() => listens === 1 && reads > 0);
    f.access.apiKeys.delete(f.first.id);
    await deadline(cleanupStarted.promise);
    const before = requests;
    await assertRejects(() => relay.inbox());
    assertEquals(requests, before);
    releaseCleanup.resolve();
    await poll(() => relay.health.reason === "receiver_cleanup_failed");
    assertEquals(relay.health.retryAt, 0);
    assertEquals(relay.connectionCount, 0);
    assertEquals(notices.length, 1);
    assert(notices[0].includes("receiver_cleanup_failed"));
    relay.startReceiver(() => Promise.reject(new Error("duplicate receiver")));
    await assertRejects(() => relay.inbox());
    assertEquals(listens, 1);
    assertEquals(relay.cleanupFailures, 1);
    await assertRejects(() => relay.close());
  } finally {
    releaseCleanup.resolve();
    Client.prototype.listen = original;
    await relay.close().catch(() => {});
    await f.close();
  }
});

Deno.test("review F4 server checkpoints prune aged known-completed metadata, retaining latest notices, joined scope and unknown outcomes", async () => {
  let now = 100;
  const f = await routingFixture(() => now);
  try {
    await f.routing.subscribe(f.first.id, "native", 42);
    f.incoming(roomMessage(5));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    const d = f.routing.inbox(f.first.id).deliveries[0],
      claim = f.routing.claim(
        f.first.id,
        d.delivery_id,
        crypto.randomUUID(),
        "native",
      );
    f.routing.complete(
      f.first.id,
      d.delivery_id,
      claim.claim_token!,
      "mirrored",
    );
    await f.routing.subscribe(f.first.id, "other", 42);
    await poll(() =>
      f.routing.store.read().notices.every((n) => n.state !== "attempting")
    );
    const unused = f.routing.namespace(f.second.id);
    f.access.apiKeys.delete(f.second.id);
    f.routing.store.write((s) => {
      s.deliveries.push({
        ...structuredClone(s.deliveries[0]),
        delivery_id: crypto.randomUUID(),
        completed_at: undefined,
      });
      s.deliveries.push({
        ...structuredClone(s.deliveries[0]),
        delivery_id: crypto.randomUUID(),
        state: "claimed",
        completed_at: undefined,
        outcome: null,
      });
      s.deliveries.push({
        ...structuredClone(s.deliveries[0]),
        delivery_id: crypto.randomUUID(),
        mirror: "uncertain",
      });
    });
    const history = structuredClone(f.history);
    now += 8 * 86400_000;
    const after = f.routing.inbox(f.first.id);
    assertEquals(after.deliveries.length, 3);
    assert(!after.deliveries.some((r) => r.delivery_id === d.delivery_id));
    assertEquals(f.routing.store.read().notices.length, 1);
    assert(!f.routing.store.read().namespaces.some((n) => n.id === unused));
    assertEquals(
      f.routing.subscriptions(f.first.id, "native").subscriptions[0].subscribed,
      true,
    );
    assertEquals(f.history, history);
  } finally {
    await f.close();
  }
});

Deno.test("review F4 local pruning is owner-driven and retains unacknowledged terminal and token-null recovery intents", async () => {
  const f = await routingFixture(), root = await fixture("review-retention");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const relay = new ModernRelay({
    alias: "a",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  let now = Date.now();
  const ports = {
    registry: () => registry,
    relays: new Map([["a", relay]]),
    owner: "http://local.invalid/",
    directory: "/A",
    signal: new AbortController().signal,
  };
  const proxies = new Proxies({ ...ports, aliases: ["a"], changed() {} });
  const inbox = new Inbox({
    ...ports,
    now: () => now,
    opencode: {
      session: () => Promise.resolve({ id: "native" }),
      status: () => Promise.resolve({}),
    },
    changed() {},
    notify: () => Promise.resolve(),
  });
  try {
    await proxies.tools().a_room_subscribe.execute({ chat_id: 42 }, {
      sessionID: "native",
      ask: () => Promise.resolve(),
    });
    f.incoming(roomMessage(7));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    await inbox.sync("a");
    const d = registry.deliveries()[0];
    registry.write((tx) => tx.transition(d.id, "open", "cancelled", now));
    const intent = crypto.randomUUID(),
      claimant = registry.prepareRemoteClaim(intent, {
        ...await relay.scope(),
        alias: "a",
      });
    now += 8 * 86400_000;
    registry.write((tx) => tx.prune(now));
    assertEquals(registry.deliveries().length, 1);
    await inbox.sync("a"); // actual remote ACK commits before prune
    assertEquals(registry.remoteClaim(d.id)?.completed, true);
    assertEquals(registry.deliveries().length, 0);
    now += 8 * 86400_000;
    await inbox.sync("a");
    assertEquals(registry.remoteClaim(d.id), undefined);
    assertEquals(registry.deliveryEdge(d.id), undefined);
    assertEquals(registry.remoteClaim(intent)?.claimant, claimant);
  } finally {
    await inbox.close();
    await proxies.close();
    await relay.close();
    registry.close();
    await f.close();
  }
});

Deno.test("review F2 actual uncertain model post of the exact native final is retained and never automatically mirrored", async () => {
  for (const differentKey of [false, true]) {
    for (const mode of ["lost", "sent", "pending"] as const) {
      const lose = mode === "lost", epoch = crypto.randomUUID();
      const f = await routingFixture(),
        root = await fixture("review-model-attempt");
      const registry = new Registry(
        await openSqlite(`${root}/progress.sqlite`),
      );
      const relay = new ModernRelay({
        alias: "a",
        url: "http://relay.invalid/mcp",
        headers: { Authorization: `Bearer ${f.first.key}` },
        enabled: true,
      }, f.fetcher);
      const model = new ModernRelay({
        alias: "model",
        url: "http://relay.invalid/mcp",
        headers: {
          Authorization: `Bearer ${differentKey ? f.second.key : f.first.key}`,
        },
        enabled: true,
      }, async (url, init) => {
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : {};
        const response = await f.fetcher(url, init);
        if (lose && body.params?.name === "send_message") {
          await response.arrayBuffer();
          throw new Error("posted response lost");
        }
        return response;
      });
      const ports = {
        registry: () => registry,
        relays: new Map([["a", relay], ["model", model]]),
        owner: "http://local.invalid/",
        directory: "/A",
        signal: new AbortController().signal,
      };
      let rows: NativeMessage[] = [];
      const notices: string[] = [];
      const mirror = new Mirror({
        ...ports,
        epoch,
        opencode: {
          messages: () => Promise.resolve(rows),
          message: () => Promise.resolve(rows.at(-1)!),
        },
        notify: (m) => {
          notices.push(m);
          return Promise.resolve();
        },
        sendFinal: (d, text) => inbox.mirror(d, text),
      });
      const proxies = new Proxies({
        ...ports,
        aliases: ["a", "model"],
        changed() {},
        prepareSend: (...args) =>
          mirror.prepareSend?.(...args) ?? Promise.resolve([]),
        settleSend: (...args) => {
          if (mode !== "pending") mirror.settleSend?.(...args);
        },
      });
      const inbox = new Inbox({
        ...ports,
        opencode: {
          session: () => Promise.resolve({ id: "native" }),
          status: () => Promise.resolve({}),
        },
        changed() {},
        notify: () => Promise.resolve(),
      });
      try {
        await proxies.tools().a_room_subscribe.execute({ chat_id: 42 }, {
          sessionID: "native",
          ask: () => Promise.resolve(),
        });
        f.incoming(roomMessage(29));
        await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
        await inbox.sync("a");
        const d = registry.deliveries()[0],
          submission = registry.write((tx) =>
            tx.allocateSubmission(d.id, epoch, 0, Date.now())
          );
        registry.write((tx) =>
          tx.updateSubmission({ ...submission, state: "admitted" })
        );
        const claimScope = await relay.scope(), sendScope = await model.scope();
        assertEquals(claimScope.identity, sendScope.identity);
        assertEquals(claimScope.uri === sendScope.uri, !differentKey);
        const text = "exact final, never duplicate α";
        rows = [
          {
            info: {
              id: submission.message_id,
              role: "user",
              time: { created: 1 },
            },
            parts: [{
              id: submission.part_id,
              type: "text",
              metadata: {
                deltaChatWake: {
                  deliveryId: d.id,
                  relay: d.relay,
                  chatId: d.chat_id,
                },
              },
            }],
          },
          {
            info: {
              id: "assistant",
              role: "assistant",
              sessionID: "native",
              parentID: submission.message_id,
              time: { created: 2 },
            },
            parts: [{
              id: "tool",
              type: "tool",
              tool: "model_send_message",
              callID: "call",
              state: { status: "running", input: { chat_id: 42, text } },
            }],
          },
        ];
        const send = () =>
          proxies.tools().model_send_message.execute({ chat_id: 42, text }, {
            sessionID: "native",
            messageID: "assistant",
            ...(mode === "lost" ? { callID: "call" } : {}),
            ask: () => Promise.resolve(),
          });
        // Keep the consumer regression runnable against the preserved pre-intent
        // implementation; these new-API negative checks run on corrected source.
        if (typeof mirror.prepareSend === "function") {
          await assertRejects(() =>
            proxies.tools().model_send_message.execute({ chat_id: 42, text }, {
              sessionID: "native",
              messageID: "assistant",
              ask: () => Promise.reject(new Error("permission denied")),
            })
          );
          if (!differentKey) {
            await assertRejects(() =>
              proxies.tools().model_send_message.execute(
                { chat_id: 42, text },
                {
                  sessionID: "native",
                  messageID: "not-the-native-assistant",
                  ask: () => Promise.resolve(),
                },
              )
            );
          }
          assertEquals(registry.modelAttempts(d.id), []);
          assertEquals(f.sent.filter((s) => s.text === text).length, 0);
          rows.push({
            info: { id: "main-input", role: "user", time: { created: 3 } },
            parts: [{
              id: "main-part",
              type: "text",
              text: "main-channel input",
            }],
          }, {
            info: {
              id: "main-assistant",
              role: "assistant",
              parentID: "main-input",
              time: { created: 4 },
            },
            parts: [],
          });
          assertEquals(
            await mirror.prepareSend("model", sendScope, {
              chat_id: 42,
              text,
            }, { sessionID: "native", messageID: "main-assistant" }),
            [],
          );
          rows.splice(-2);
          assertEquals(
            await mirror.prepareSend(
              "model",
              { ...sendScope, identity: "other@example.invalid" },
              { chat_id: 42, text },
              { sessionID: "native", messageID: "assistant" },
            ),
            [],
          );
          assertEquals(
            await mirror.prepareSend(
              "model",
              sendScope,
              { chat_id: 99, text },
              { sessionID: "native", messageID: "assistant" },
            ),
            [],
          );
          assertEquals(registry.modelAttempts(d.id), []);
        }
        if (lose) await assertRejects(send);
        else await send();
        rows.push({
          info: {
            id: "final",
            role: "assistant",
            parentID: submission.message_id,
            finish: "stop",
            time: { created: 3, completed: 4 },
          },
          parts: [{ id: "answer", type: "text", text }],
        });
        registry.write((tx) =>
          tx.recordAnswer(
            d.id,
            0,
            { messageID: "final", partIDs: ["answer"] },
            Date.now(),
          )
        );
        await mirror.ready(registry.deliveries()[0]);
        await poll(() =>
          ["mirror_uncertain", "answered_by_model", "mirrored"].includes(
            registry.deliveries()[0].state,
          )
        );
        assertEquals(f.sent.filter((s) => s.text === text).length, 1);
        assertEquals(
          registry.deliveries()[0].state,
          mode === "sent" ? "answered_by_model" : "mirror_uncertain",
        );
        const attempt = registry.modelAttempts(d.id)[0];
        assertEquals(attempt.status, mode === "lost" ? "uncertain" : mode);
        assertEquals(registry.execution(d.id, 0)?.answerID, "final");
        assertEquals(notices.length, mode === "sent" ? 0 : 1);
        assert(!JSON.stringify(registry.modelAttempts(d.id)).includes(text));
        assertEquals(registry.deliveryEdge(d.id)?.uri, claimScope.uri);
        if (differentKey) {
          relay.config.enabled = false;
          assertEquals(
            await inbox.transport(registry.deliveries()[0]),
            undefined,
          );
          relay.config.enabled = true;
          assertEquals(
            (await inbox.bodies(registry.deliveries()[0]))?.map((m) => m.id),
            [29],
          );
        }
      } finally {
        await inbox.close();
        await proxies.close();
        await mirror.close();
        await relay.close();
        await model.close();
        registry.close();
        await f.close();
      }
    }
  }
});

Deno.test("review F6 enabled same-scope edge claims a target bound only through a paused alias; foreign namespace cannot adopt", async () => {
  const f = await routingFixture(), root = await fixture("review-alias");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  const make = (alias: string, key: string) =>
    new ModernRelay({
      alias,
      url: "http://relay.invalid/mcp",
      headers: { Authorization: `Bearer ${key}` },
      enabled: true,
    }, f.fetcher);
  const a = make("a", f.first.key),
    b = make("b", f.first.key),
    foreign = make("foreign", f.second.key);
  const ports = {
    registry: () => registry,
    relays: new Map([["a", a], ["b", b], ["foreign", foreign]]),
    owner: "http://local.invalid/",
    directory: "/A",
    signal: new AbortController().signal,
  };
  const proxies = new Proxies({
    ...ports,
    aliases: ["a", "b", "foreign"],
    changed() {},
  });
  const received: string[] = [];
  const inbox = new Inbox({
    ...ports,
    opencode: {
      session: () => Promise.resolve({ id: "native" }),
      status: () => Promise.resolve({}),
    },
    changed(s) {
      received.push(s);
    },
    notify: () => Promise.resolve(),
  });
  try {
    await proxies.tools().a_room_subscribe.execute({ chat_id: 42 }, {
      sessionID: "native",
      ask: () => Promise.resolve(),
    });
    a.config.enabled = false;
    // Foreign key owns a server target with the same session ID but no local scope binding.
    await f.routing.subscribe(f.second.id, "native", 42);
    f.incoming(roomMessage(19));
    await poll(() => f.routing.inbox(f.second.id).deliveries.length === 1);
    await inbox.sync("foreign");
    assertEquals(received, []);
    f.routing.interest(f.first.id, "native", 42);
    await inbox.sync("b");
    assertEquals(received, ["native"]);
    assertEquals(
      (await inbox.bodies(registry.deliveries()[0]))?.map((m) => m.id),
      [19],
    );
    assertEquals(registry.remoteBindings().map((r) => r.alias), ["a"]);
  } finally {
    await inbox.close();
    await proxies.close();
    await Promise.all([a.close(), b.close(), foreign.close()]);
    registry.close();
    await f.close();
  }
});

Deno.test("review F1 claimant survives accepted response loss; only positive import freezes scope and batch", async () => {
  const f = await routingFixture(), root = await fixture("review-grant");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  let lose = true;
  const relay = new ModernRelay({
    alias: "a",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const response = await f.fetcher(url, init);
    if (lose && body.params?.name === "inbox_claim") {
      lose = false;
      await response.arrayBuffer();
      throw new Error("accepted response lost");
    }
    return response;
  });
  const ports = {
    registry: () => registry,
    relays: new Map([["a", relay]]),
    owner: "http://local.invalid/",
    directory: "/A",
    signal: new AbortController().signal,
  };
  const proxies = new Proxies({ ...ports, aliases: ["a"], changed() {} });
  let changes = 0;
  const inbox = new Inbox({
    ...ports,
    opencode: {
      session: () => Promise.resolve({ id: "native" }),
      status: () => Promise.resolve({}),
    },
    changed() {
      changes++;
    },
    notify: () => Promise.resolve(),
  });
  try {
    await proxies.tools().a_room_subscribe.execute({ chat_id: 42 }, {
      sessionID: "native",
      ask: () => Promise.resolve(),
    });
    f.incoming(roomMessage(23));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    await assertRejects(() => inbox.sync("a"));
    const remote = f.routing.inbox(f.first.id).deliveries[0];
    assertEquals(
      registry.remoteClaim(remote.delivery_id)?.claimant,
      remote.claimant,
    );
    assertEquals(registry.deliveryEdge(remote.delivery_id), undefined);
    assertEquals(changes, 0);
    await inbox.sync("a");
    assertEquals(changes, 1);
    const edge = registry.deliveryEdge(remote.delivery_id)!;
    const input = {
      id: remote.delivery_id,
      session: "native",
      alias: "a",
      relay: edge.identity,
      chat: 42,
      anchor: remote.from_anchor,
      ids: remote.message_ids,
      token: registry.remoteClaim(remote.delivery_id)!.token!,
      claimant: remote.claimant!,
      owner: ports.owner,
      directory: ports.directory,
      edge,
    };
    registry.importRemote(input);
    assertThrows(() =>
      registry.importRemote({
        ...input,
        edge: { ...edge, uri: `deltachat://inbox/${crypto.randomUUID()}` },
      })
    );
    assertThrows(() =>
      registry.importRemote({ ...input, token: crypto.randomUUID() })
    );
    assertThrows(() => registry.importRemote({ ...input, chat: 99 }));
    assertThrows(() => registry.importRemote({ ...input, ids: [99] }));
    assertEquals(
      (await inbox.bodies(registry.deliveries()[0]))?.map((m) => m.id),
      [23],
    );
  } finally {
    await inbox.close();
    await proxies.close();
    await relay.close();
    registry.close();
    await f.close();
  }
});

Deno.test("review F2 application reconciliation failure does not abort a held successful ordinary send", async () => {
  const f = await routingFixture();
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let aborted = false, fail = false, reads = 0, listens = 0;
  const relay = new ModernRelay({
    alias: "a",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body.method === "subscriptions/listen") listens++;
    if (body.params?.name === "send_message") {
      const response = await f.fetcher(url, init);
      held.resolve();
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      await release.promise;
      if (init?.signal?.aborted) throw new Error("shared send aborted");
      return response;
    }
    return f.fetcher(url, init);
  });
  let send: Promise<unknown> | undefined;
  try {
    relay.startReceiver(async () => {
      reads++;
      if (fail) {
        fail = false;
        throw new RelayFailure(
          "tool_error",
          false,
          "request_failed",
          "application",
        );
      }
      await relay.inbox();
    });
    await poll(() => reads > 0);
    send = relay.send(42, "exact held final").catch((e) => e);
    await deadline(held.promise);
    fail = true;
    const before = reads;
    f.routing.interest(f.first.id, "native", 42);
    await poll(() => reads > before);
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(aborted, false);
    release.resolve();
    const result = await send;
    assert(!(result instanceof Error));
    assertEquals((result as { chat_id: number }).chat_id, 42);
    await poll(() => reads > before + 1, 5000);
    assertEquals(listens, 1);
    assertEquals(f.sent.filter((s) => s.text === "exact held final").length, 1);
  } finally {
    release.resolve();
    await send;
    await relay.close();
    await f.close();
  }
});

Deno.test("review F2 an application completion failure defers its receipt without starving another delivery", async () => {
  const f = await routingFixture(),
    root = await fixture("review-complete-isolation");
  const registry = new Registry(await openSqlite(`${root}/progress.sqlite`));
  let fail = false;
  const complete = f.routing.complete.bind(f.routing);
  f.routing.complete = (...args) => {
    if (fail) throw new Error("Owned canonical completion application failure");
    return complete(...args);
  };
  const relay = new ModernRelay({
    alias: "a",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, f.fetcher);
  const ports = {
    registry: () => registry,
    relays: new Map([["a", relay]]),
    owner: "http://local.invalid/",
    directory: "/A",
    signal: new AbortController().signal,
  };
  const proxies = new Proxies({ ...ports, aliases: ["a"], changed() {} });
  const changes: string[] = [];
  const inbox = new Inbox({
    ...ports,
    opencode: {
      session: () => Promise.resolve({ id: "native" }),
      status: () => Promise.resolve({}),
    },
    changed(s) {
      changes.push(s);
    },
    notify: () => Promise.resolve(),
  });
  try {
    await proxies.tools().a_room_subscribe.execute({ chat_id: 42 }, {
      sessionID: "native",
      ask: () => Promise.resolve(),
    });
    f.incoming(roomMessage(31));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    await inbox.sync("a");
    const first = registry.deliveries()[0];
    registry.write((tx) =>
      tx.transition(first.id, "open", "cancelled", Date.now())
    );
    f.incoming(roomMessage(13));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 2);
    fail = true;
    const error = await assertRejects(() => inbox.sync("a"), RelayFailure);
    assertEquals(error.domain, "application");
    assertEquals(changes.length, 3); // initial, existing terminal hint, new batch
    assertEquals(registry.deliveries().length, 2);
    const next = registry.deliveries().find((d) => d.id !== first.id)!;
    assertEquals((await inbox.bodies(next))?.map((m) => m.id), [13]);
    assertEquals(registry.remoteClaim(first.id)?.completed, false);
    fail = false;
    await inbox.sync("a");
    assertEquals(registry.remoteClaim(first.id)?.completed, true);
  } finally {
    await inbox.close();
    await proxies.close();
    await relay.close();
    registry.close();
    await f.close();
  }
});
