// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import plugin, { type Foundation } from "../../integrations/opencode/mod.ts";
import { deadline, fixture } from "../support.ts";

// Exercise the real plugin hook -> Dispatcher/Inbox composition, with
// counted transport/native ports. Do not replace Inbox.all with a spy: the
// contract concerns I/O at the end of that path, including server-only work.
Deno.test("composition ignores irrelevant event bursts but reconciles server-only work on native decisions", async () => {
  const root = await fixture("opencode-composition-events");
  const session = "ses_server_only";
  const identity = "relay@example.invalid";
  const receiverStarted = Promise.withResolvers<void>();
  const observed: unknown[] = [];
  const calls = {
    relayGuard: 0,
    inbox: 0,
    identity: 0,
    relayHistory: 0,
    relayTools: 0,
    claims: 0,
    nativeSession: 0,
    nativeStatus: 0,
    nativeHistory: 0,
    nativeMessage: 0,
    nativeSubmit: 0,
    nativeToast: 0,
  };
  const ready = {
    delivery_id: crypto.randomUUID(),
    target_session: session,
    chat_id: 42,
    from_anchor: 90,
    message_ids: [5],
    state: "ready" as const,
    claimant: null,
    outcome: null,
    mirror: "none" as const,
    mirror_message_id: null,
  };
  const foundationReady = Promise.withResolvers<Foundation>();
  const hooks = await plugin({
    directory: root,
    serverUrl: new URL("http://opencode.invalid/"),
    client: {
      session: {
        get() {
          calls.nativeSession++;
          // Keep the genuine server-ready batch pending at a known native
          // admission guard. This test must not create a local delivery first.
          return Promise.resolve({
            data: { id: session, revert: { messageID: "msg_revert" } },
          });
        },
        status() {
          calls.nativeStatus++;
          return Promise.resolve({ data: {} });
        },
        messages() {
          calls.nativeHistory++;
          throw new Error("Reverted server-only work must not read history");
        },
        message() {
          calls.nativeMessage++;
          throw new Error("No local native submission exists to confirm");
        },
        promptAsync() {
          calls.nativeSubmit++;
          throw new Error("A native revert must prevent admission");
        },
      },
      tui: {
        showToast() {
          calls.nativeToast++;
          return Promise.resolve({ data: true });
        },
      },
    },
  }, {
    relays: {
      relay: { url: "http://relay.invalid/mcp", enabled: true },
    },
    stateFile: `${root}/progress.sqlite`,
  }, {
    attach(f) {
      foundationReady.resolve(f);
      f.registry.bindRemote(session, "relay", identity, f.owner, f.directory, {
        identity,
        uri: "deltachat://inbox/composition-events",
      });
      return {
        event(input: unknown) {
          observed.push(input);
        },
      };
    },
  });
  const foundation = await foundationReady.promise;
  const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    hooks.config({});
    const relay = foundation.relays.get("relay");
    assert(relay);
    // Isolate native event scheduling from independently owned MCP updates.
    // Startup still reaches the real composition's receiver-start boundary.
    relay.startReceiver = () => {
      receiverStarted.resolve();
    };
    relay.refreshNativeState = () => {
      calls.relayGuard++;
      return Promise.resolve(true);
    };
    relay.inbox = () => {
      calls.inbox++;
      return Promise.resolve({
        deliveries: [ready],
        rooms: [{ chat_id: 42, state: "active", anchor_id: 90 }],
      });
    };
    relay.identity = () => {
      calls.identity++;
      return Promise.resolve(identity);
    };
    relay.scope = async () => ({
      identity: await relay.identity(),
      uri: "deltachat://inbox/composition-events",
    });
    relay.read = () => {
      calls.relayHistory++;
      throw new Error("No receiver history read is authorized here");
    };
    relay.bodies = () => {
      calls.relayHistory++;
      throw new Error("Unclaimed work must not request claimed bodies");
    };
    relay.call = () => {
      calls.relayTools++;
      throw new Error("No receiver control/tool call is authorized here");
    };
    relay.claim = () => {
      calls.claims++;
      throw new Error("Native revert must defer the server claim");
    };
    await deadline(receiverStarted.promise);
    await turn();
    assertEquals(foundation.registry.subscriptions(), []);
    assertEquals(foundation.registry.deliveries(), []);
    const before = { ...calls };
    assertEquals(before.inbox, 0);
    const irrelevant: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      for (
        const event of [
          {
            type: "message.part.delta",
            properties: { sessionID: session, delta: "x" },
          },
          {
            type: "message.part.updated",
            properties: { part: { sessionID: session, type: "text" } },
          },
          {
            type: "message.updated",
            properties: { info: { sessionID: session, role: "assistant" } },
          },
        ]
      ) {
        const input = { event };
        irrelevant.push(input);
        hooks.event(input);
      }
      // Separate chunks by event-loop turns: coalescing is not a substitute
      // for rejecting irrelevant events before any inbox/identity/status I/O.
      if (i % 100 === 0) await turn();
    }
    await turn();
    assertEquals(calls, before);
    assertEquals(observed, irrelevant);

    const decisions = [
      { type: "session.idle", properties: { sessionID: session } },
      {
        type: "session.status",
        properties: { sessionID: session, status: { type: "idle" } },
      },
      {
        type: "session.updated",
        properties: {
          info: { id: session, revert: { messageID: "msg_revert" } },
        },
      },
      { type: "session.deleted", properties: { info: { id: session } } },
      { type: "session.created", properties: { info: { id: session } } },
      { type: "session.error", properties: { sessionID: session } },
      {
        type: "message.updated",
        properties: { info: { sessionID: session, role: "user" } },
      },
    ];
    for (const [index, event] of decisions.entries()) {
      const input = { event };
      hooks.event(input);
      await turn();
      const expected = index + 1;
      assertEquals(calls.inbox - before.inbox, expected, event.type);
      assertEquals(calls.identity - before.identity, expected, event.type);
      assertEquals(
        calls.nativeSession - before.nativeSession,
        expected,
        event.type,
      );
      assertEquals(
        calls.nativeStatus - before.nativeStatus,
        expected,
        event.type,
      );
      assert(observed.at(-1) === input);
      assertEquals(foundation.registry.deliveries(), []);
    }
    assertEquals(calls.claims, 0);
    assertEquals(calls.relayHistory, 0);
    assertEquals(calls.relayTools, 0);
    assertEquals(calls.nativeHistory, 0);
    assertEquals(calls.nativeMessage, 0);
    assertEquals(calls.nativeSubmit, 0);
    assertEquals(calls.nativeToast, 0);
    assertEquals(observed.length, irrelevant.length + decisions.length);
  } finally {
    await hooks.dispose();
  }
});

Deno.test("idle fence composition commits handoff before abort and repeated dispose joins the same promise", async () => {
  const root = await fixture("opencode-idle-composition");
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let foundation!: Foundation;
  let observed: unknown;
  let stopCalls = 0;
  const hooks = await plugin({
    directory: root,
    serverUrl: "http://opencode.invalid/",
    client: {
      session: {
        get: () => Promise.resolve({ data: { id: "session" } }),
        status: () => Promise.resolve({ data: {} }),
        messages: async () => {
          entered.resolve();
          await resume.promise;
          return { data: [] };
        },
        promptAsync: () => {
          throw new Error("fenced preparation cannot POST");
        },
      },
      tui: { showToast: () => Promise.resolve({ data: true }) },
    },
  }, {
    relays: { relay: { url: "http://relay.invalid/mcp", enabled: true } },
    stateFile: `${root}/wake.sqlite`,
  }, {
    attach(f) {
      foundation = f;
      const id = crypto.randomUUID(),
        edge = {
          alias: "relay",
          identity: "relay@example.invalid",
          uri: "deltachat://inbox/idle-composition",
        };
      const claimant = f.registry.prepareRemoteClaim(id, edge);
      f.registry.importRemote({
        id,
        claimant,
        edge,
        token: crypto.randomUUID(),
        session: "session",
        alias: "relay",
        relay: edge.identity,
        chat: 42,
        anchor: 90,
        ids: [5],
        owner: f.owner,
        directory: f.directory,
      });
      f.signal.addEventListener("abort", () => {
        observed = f.registry.write((tx) =>
          tx.tryAcquireLease("session", "successor", f.owner, Date.now())
        );
      }, { once: true });
      f.onStop(() => {
        stopCalls++;
        return stopped.promise;
      });
      return {};
    },
  });
  try {
    hooks.config({});
    const relay = foundation.relays.get("relay")!;
    relay.startReceiver = () => {};
    relay.matchesScope = (scope) =>
      relay.config.enabled && scope.identity === "relay@example.invalid" &&
      scope.uri === "deltachat://inbox/idle-composition";
    await deadline(entered.promise);
    assertEquals(
      foundation.registry.write((tx) =>
        tx.tryAcquireLease("session", "successor", foundation.owner, Date.now())
      ).acquired,
      false,
    );
    const first = hooks.dispose();
    assertEquals(
      observed,
      { acquired: true },
      "abort listener sees committed idle handoff synchronously",
    );
    const second = hooks.dispose();
    assert(
      first === second,
      "repeat caller must receive the exact pending disposal promise",
    );
    let joined = false;
    void second.then(() => {
      joined = true;
    });
    resume.resolve();
    await Promise.resolve();
    assertEquals(joined, false);
    assertEquals(stopCalls, 1);
    stopped.resolve();
    await deadline(first);
    assert(hooks.dispose() === first);
  } finally {
    resume.resolve();
    stopped.resolve();
    await hooks.dispose();
  }
});

Deno.test("idle fence composition still aborts and joins consumers when its registry transaction fails", async () => {
  const root = await fixture("opencode-idle-composition-failure");
  const stopped = Promise.withResolvers<void>();
  let foundation!: Foundation;
  let aborted = false, joins = 0;
  const hooks = await plugin({
    directory: root,
    serverUrl: "http://opencode.invalid/",
    client: {},
  }, {
    relays: { relay: { url: "http://relay.invalid/mcp", enabled: false } },
    stateFile: `${root}/wake.sqlite`,
  }, {
    attach(f) {
      foundation = f;
      f.signal.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      f.onStop(() => {
        joins++;
        return stopped.promise;
      });
      return {};
    },
  });
  const write = foundation.registry.write.bind(foundation.registry);
  foundation.registry.write = () => {
    throw new Error("transaction unavailable");
  };
  try {
    const disposal = hooks.dispose();
    assertEquals(aborted, true);
    assertEquals(joins, 1);
    assert(hooks.dispose() === disposal);
    let joined = false;
    void disposal.then(() => {
      joined = true;
    });
    await Promise.resolve();
    assertEquals(joined, false);
    foundation.registry.write = write;
    stopped.resolve();
    await deadline(disposal);
  } finally {
    foundation.registry.write = write;
    stopped.resolve();
    await hooks.dispose();
  }
});
