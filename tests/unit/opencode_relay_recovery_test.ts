// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { pathfinder } from "@pathfinder/pathfinder";
import { z } from "zod";
import {
  Relay,
  RelayFailure,
  RelayShutdownFailure,
} from "../../integrations/opencode/relay.ts";
import { McpSessions } from "../../src/mcp/sessions.ts";
import { authFixture } from "../auth_support.ts";
import { deadline, fixture, lanAddress } from "../support.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { Subscribe } from "../../integrations/opencode/subscribe.ts";

/** Real legacy HTTP sessions/client; only application outcomes and clock are
 * controlled. Records contain RPC names/session IDs, never message bodies. */
async function recoveryFixture(
  createClient?: () => Client,
  nativeGate?: () => Promise<boolean>,
) {
  const f = await authFixture({ DCMCP_AUTH_TYPE: "public" });
  const state = {
    mode: "success" as
      | "success"
      | "not_found"
      | "core_unavailable"
      | "request_failed",
    now: 100_000,
    enabled: true,
    sendSucceeds: false,
    acceptedPosts: 0,
    address: "identity@example.invalid",
    records: [] as { method: string; session: string | null; name?: string }[],
    outbound: [] as { method?: string; name?: string }[],
  };
  const createSessions = () =>
    new McpSessions(f.apiKeys, () => {
      const server = new McpServer({ name: "j2-recovery", version: "1" });
      server.registerTool("status", { inputSchema: z.object({}) }, () => {
        const data = { address: state.address };
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      });
      server.registerTool("wait_for_messages", {
        inputSchema: z.object({
          chat_id: z.number(),
          after_id: z.number(),
          timeout_seconds: z.number().int().max(2),
        }),
      }, () => {
        const data = state.mode === "success"
          ? { timedOut: true, messages: [] }
          : { error: state.mode };
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
          ...(state.mode === "success" ? {} : { isError: true }),
        };
      });
      server.registerTool("send_message", {
        inputSchema: z.object({ chat_id: z.number(), text: z.string() }),
      }, () => {
        if (!state.sendSucceeds) {
          return {
            isError: true,
            content: [{ type: "text", text: '{"error":"request_failed"}' }],
            structuredContent: { error: "request_failed" },
          };
        }
        const data = {
          message_id: 100 + ++state.acceptedPosts,
          chat_id: 42,
          state: "sent",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      });
      return server;
    });
  let sessions = createSessions();
  const handler = await pathfinder({
    roots: [new URL("../../src/http/routes/", import.meta.url)],
    app: {
      auth: f.auth,
      apiKeys: f.apiKeys,
      mcp: {
        handleRequest: (request: Request, owner?: string) =>
          sessions.handleRequest(request, owner),
      },
    },
  });
  const accept = async (request: Request) => {
    if (request.method === "POST") {
      const body = await request.clone().json();
      state.records.push({
        method: body.method,
        session: request.headers.get("mcp-session-id"),
        name: body.params?.name,
      });
    }
    return await handler(request);
  };
  const listen = (port: number) =>
    Deno.serve({ hostname: lanAddress(), port, onListen() {} }, accept);
  let http = listen(0);
  const port = http.addr.port;
  const url = `http://${lanAddress()}:${port}/mcp`;
  const relay = new Relay(
    { alias: "fixture", url, headers: {}, enabled: true },
    { enabled: nativeGate ?? (() => Promise.resolve(state.enabled)) },
    (input, init) => {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        state.outbound.push({ method: body.method, name: body.params?.name });
      }
      return fetch(input, init);
    },
    () => state.now,
    createClient,
  );
  const attempts = () => state.records.filter((r) => r.method === "tools/call");
  const initializations = () =>
    state.records.filter((r) => r.method === "initialize").length;
  return {
    state,
    relay,
    get sessions() {
      return sessions;
    },
    attempts,
    initializations,
    async stopListener() {
      await sessions.close();
      await http.shutdown();
    },
    restartListener() {
      sessions = createSessions();
      http = listen(port);
    },
    async expire() {
      const session = attempts().at(-1)?.session;
      assert(session);
      const response = await fetch(url, {
        method: "DELETE",
        headers: { "mcp-session-id": session },
      });
      assert(response.ok);
      await response.body?.cancel();
    },
    async close() {
      const errors: unknown[] = [];
      // The remote owner stays alive until its client has terminated its MCP
      // session. Server shutdown racing DELETE is a real cleanup failure.
      try {
        await relay.close();
      } catch (error) {
        errors.push(error);
      }
      const results = await Promise.allSettled([
        sessions.close(),
        http.shutdown(),
      ]);
      f.close();
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (errors.length) {
        throw new AggregateError(
          errors,
          "Fixture shutdown failed",
        );
      }
    },
  };
}

Deno.test("relay identity invalidation during native guard cannot lose accepted re-subscription", async () => {
  let holdNext = false;
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<boolean>();
  const f = await recoveryFixture(undefined, () => {
    if (holdNext) {
      holdNext = false;
      entered.resolve();
      return released.promise;
    }
    return Promise.resolve(true);
  });
  const registry = new Registry(
    await openSqlite(`${await fixture("relay-identity-race")}/routing.sqlite`),
  );
  const signal = new AbortController();
  const identities: unknown[] = [];
  const subscription = new Subscribe({
    registry: () => registry,
    directory: "/identity-race",
    owner: "http://localhost:4097/",
    aliases: ["fixture"],
    unroutable: new Set(),
    signal: signal.signal,
    relays: new Map([["fixture", {
      identity: async (signal?: AbortSignal) => {
        const value = await f.relay.identity(signal);
        identities.push(value);
        return value;
      },
      call: f.relay.call.bind(f.relay),
      get health() {
        return f.relay.health;
      },
    }]]),
    toast: () => Promise.resolve(),
  });
  try {
    const row = registry.write((tx) =>
      tx.subscribe({
        session_id: "session",
        relay: f.state.address,
        chat_id: 42,
        directory: "/identity-race",
        owner_server: "http://localhost:4097/",
        alias: "fixture",
        message_id: 10,
      }, 1)
    );
    registry.write((tx) => tx.leave(row, 2));
    f.state.sendSucceeds = true;
    const accepted = await f.relay.send(
      42,
      "accepted explicit re-subscription",
    );
    assertEquals(await f.relay.identity(), f.state.address);
    const result = {
      content: [{ type: "text", text: JSON.stringify(accepted) }],
      structuredContent: accepted,
    };
    holdNext = true;
    const observation = subscription.after({
      sessionID: "session",
      callID: "call_fixture",
      tool: "fixture_send_message",
      args: { chat_id: 42, text: "accepted explicit re-subscription" },
    }, result);
    await deadline(entered.promise, 1000);
    // A different accepted mirror's isolated connection closes while the
    // subscription identity read is suspended at its native-enable guard.
    const mirror = await f.relay.send(42, "previous admitted room final");
    released.resolve(true);
    await observation;
    const current = registry.subscriptions("session")[0];
    console.log({
      scenario: "identity-guard-send-close",
      acceptedID: accepted.message_id,
      mirrorID: mirror.message_id,
      identityTypes: identities.map((v) => typeof v),
      subscriptionState: current.state,
      notice: result.content.at(-1)?.text,
    });
    assertEquals(identities, [f.state.address]);
    assertEquals(current.state, "active");
    assertEquals(current.anchor_id, accepted.message_id);
    assertEquals(f.state.acceptedPosts, 2);
    assertEquals(result.structuredContent, accepted);
    assert(result.content.at(-1)!.text.includes("this session is subscribed"));
  } finally {
    released.resolve(true);
    signal.abort();
    await subscription.close();
    registry.close();
    await f.close();
  }
});

Deno.test("relay invalidated identity revalidates canonical address and still honours operator pause", async () => {
  for (const enabled of [true, false]) {
    let holdNext = false;
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<boolean>();
    const f = await recoveryFixture(undefined, () => {
      if (holdNext) {
        holdNext = false;
        entered.resolve();
        return released.promise;
      }
      return Promise.resolve(true);
    });
    try {
      f.state.sendSucceeds = true;
      assertEquals(await f.relay.identity(), f.state.address);
      holdNext = true;
      const pending = f.relay.identity();
      const rejected = enabled
        ? undefined
        : assertRejects(() => pending, RelayFailure);
      await deadline(entered.promise, 1000);
      await f.relay.send(
        42,
        "accepted prior mirror invalidates identity cache",
      );
      f.state.address = "replacement@example.invalid";
      const statuses = f.attempts().filter((a) => a.name === "status").length;
      released.resolve(enabled);
      if (enabled) {
        assertEquals(await pending, f.state.address);
        assertEquals(
          f.attempts().filter((a) => a.name === "status").length,
          statuses + 1,
        );
      } else {
        assertEquals((await rejected!)?.kind, "paused");
        assertEquals(
          f.attempts().filter((a) => a.name === "status").length,
          statuses,
        );
      }
    } finally {
      released.resolve(true);
      await f.close();
    }
  }
});

Deno.test("relay anchor outcomes pool reads while each uncertain send owns a fresh session", async () => {
  const f = await recoveryFixture();
  try {
    f.state.mode = "not_found";
    for (let i = 0; i < 3; i++) {
      const error = await assertRejects(
        () => f.relay.wait(42, 10, 300),
        RelayFailure,
      );
      assertEquals(error.domain, "application");
      assertEquals(error.reason, "not_found");
      assertEquals(f.relay.health, { state: "connected", retryAt: 0 });
      assertEquals(f.sessions.sessionCount, 1);
    }
    const send = await assertRejects(
      () => f.relay.send(42, "fixture-error"),
      RelayFailure,
    );
    assertEquals(send.kind, "uncertain");
    assertEquals(send.retrySafe, false);
    assertEquals(send.domain, "application");
    f.state.mode = "success";
    assertEquals(await f.relay.wait(42, 10, 300), {
      timedOut: true,
      messages: [],
    });
    assertEquals(f.attempts().length, 5);
    assertEquals(f.initializations(), 2);
    assertEquals(
      new Set(
        f.attempts().filter((r) => r.name === "wait_for_messages").map((r) =>
          r.session
        ),
      ).size,
      1,
    );
    assertEquals(new Set(f.attempts().map((r) => r.session)).size, 2);
    assertEquals(f.sessions.sessionCount, 1);
    console.log(
      JSON.stringify({
        gate: "relay-application-domain",
        actualAttempts: 5,
        nativeInitializations: 2,
        reusedReadSessions: 1,
        isolatedSendSessions: 1,
        anchorReason: "not_found",
        sendUncertain: true,
      }),
    );
  } finally {
    await f.close();
  }
});

Deno.test("relay real core outcomes grow bounded backoff on a reused session; guard rejections never postpone retry", async () => {
  const f = await recoveryFixture();
  try {
    f.state.mode = "core_unavailable";
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    const deadlines: number[] = [];
    for (const delay of delays) {
      f.state.now = Math.max(f.state.now, f.relay.health.retryAt);
      const before = f.attempts().length;
      const error = await assertRejects(
        () => f.relay.wait(42, 10, 300),
        RelayFailure,
      );
      assertEquals(error.reason, "core_unavailable");
      assertEquals(error.domain, "application");
      assertEquals(f.attempts().length, before + 1);
      const expected = { state: "connected", retryAt: f.state.now + delay };
      assertEquals(f.relay.health, expected);
      deadlines.push(expected.retryAt);
      const wire = f.state.records.length;
      for (let i = 0; i < 5; i++) {
        f.state.now++;
        const guarded = await assertRejects(
          () => f.relay.wait(42, 10, 300),
          RelayFailure,
        );
        assertEquals(guarded.domain, "guard");
        assertEquals(f.relay.health, expected);
        assertEquals(f.state.records.length, wire);
      }
      const aborted = new AbortController();
      aborted.abort();
      const cancelled = await assertRejects(
        () => f.relay.wait(42, 10, 300, aborted.signal),
        RelayFailure,
      );
      assertEquals(cancelled.kind, "cancelled");
      assertEquals(cancelled.domain, "guard");
      assertEquals(f.relay.health, expected);
      assertEquals(f.state.records.length, wire);
    }
    assertEquals(f.initializations(), 1);
    assertEquals(f.sessions.sessionCount, 1);
    f.state.now = f.relay.health.retryAt;
    f.state.mode = "success";
    await f.relay.wait(42, 10, 300);
    assertEquals(f.relay.health, { state: "connected", retryAt: 0 });
    f.state.mode = "core_unavailable";
    await assertRejects(() => f.relay.wait(42, 10, 300), RelayFailure);
    assertEquals(f.relay.health.retryAt, f.state.now + 1000);
    assertEquals(f.attempts().length, 10);
    assertEquals(f.initializations(), 1);
    console.log(
      JSON.stringify({
        gate: "relay-backoff-guards",
        actualAttempts: 10,
        nativeInitializations: 1,
        delays,
        deadlines,
        guardedAttempts: 0,
        recoveredDelay: 1000,
      }),
    );
  } finally {
    await f.close();
  }
});

Deno.test("relay successful reinitialization cannot reset consecutive operation failures", async () => {
  const f = await recoveryFixture();
  try {
    f.state.mode = "core_unavailable";
    await assertRejects(() => f.relay.wait(42, 10, 300), RelayFailure);
    assertEquals(f.relay.health.retryAt, f.state.now + 1000);
    await f.expire();
    f.state.now = f.relay.health.retryAt;
    const expired = await assertRejects(
      () => f.relay.wait(42, 10, 300),
      RelayFailure,
    );
    assertEquals(expired.kind, "session_expired");
    assertEquals(f.relay.health.retryAt, f.state.now + 2000);
    f.state.now = f.relay.health.retryAt;
    await assertRejects(() => f.relay.wait(42, 10, 300), RelayFailure);
    assertEquals(f.relay.health.retryAt, f.state.now + 4000);
    assertEquals(f.initializations(), 2);
    assertEquals(f.attempts().length, 3);
    assertEquals(new Set(f.attempts().map((r) => r.session)).size, 2);
    f.state.now = f.relay.health.retryAt;
    f.state.mode = "success";
    await f.relay.wait(42, 10, 300);
    assertEquals(f.relay.health.retryAt, 0);
    console.log(
      JSON.stringify({
        gate: "relay-reconnect-domain",
        actualAttempts: 4,
        nativeInitializations: 2,
        failureDelays: [1000, 2000, 4000],
        recovered: true,
      }),
    );
  } finally {
    await f.close();
  }
});

Deno.test("relay cleanup failure preserves original operation failure and remains visible to shutdown", async () => {
  class FailingCloseClient extends Client {
    override async close() {
      await super.close();
      throw new Error("j2-owned-close-failure");
    }
  }
  const f = await recoveryFixture(() =>
    new FailingCloseClient({ name: "j2-close", version: "1" })
  );
  try {
    await f.relay.wait(42, 10, 300);
    await f.expire();
    const original = await assertRejects(
      () => f.relay.wait(42, 10, 300),
      RelayFailure,
    );
    assertEquals(original.kind, "session_expired");
    assertEquals(original.retrySafe, true);
    assertEquals(original.cleanupFailures, 1);
    assertEquals(f.sessions.sessionCount, 0);
    const shutdown = await assertRejects(
      () => f.relay.close(),
      RelayShutdownFailure,
    );
    assertEquals(shutdown.failures, 1);
    const repeated = await assertRejects(
      () => f.relay.close(),
      RelayShutdownFailure,
    );
    assertEquals(repeated.failures, 1);
    console.log(
      JSON.stringify({
        gate: "relay-cleanup-domain",
        originalKind: original.kind,
        originalRetrySafe: true,
        cleanupFailures: 1,
        shutdownRejected: true,
        remoteSessions: 0,
      }),
    );
  } finally {
    // The tested shutdown failure must remain observable; all native resources
    // are still joined by the fixture, whose aggregate includes that failure.
    await assertRejects(() => f.close(), AggregateError);
  }
});

Deno.test("all send entry points perform fresh handshake/catalog, one call, and disposal while reads pool", async () => {
  const f = await recoveryFixture();
  try {
    f.state.sendSucceeds = true;
    await f.relay.wait(42, 10, 300);
    const readSession = f.attempts()[0].session;
    const first = await f.relay.send(42, "fresh-send-one");
    assertEquals(first.message_id, 101);
    const second = await f.relay.call("send_message", {
      chat_id: 42,
      text: "fresh-send-two",
    });
    assertEquals(second, { message_id: 102, chat_id: 42, state: "sent" });
    assertEquals(f.initializations(), 3);
    const sends = f.attempts().filter((r) => r.name === "send_message");
    assertEquals(sends.length, 2);
    assertEquals(new Set(sends.map((r) => r.session)).size, 2);
    for (const send of sends) {
      assert(send.session !== readSession);
      assertEquals(
        f.attempts().filter((r) => r.session === send.session).length,
        1,
      );
      assertEquals(
        f.state.records.filter((r) =>
          r.session === send.session && r.method === "tools/list"
        ).length,
        1,
      );
    }
    assertEquals(
      f.sessions.sessionCount,
      1,
      "Only the pooled read session remains",
    );
    await f.relay.wait(42, 10, 300);
    assertEquals(f.attempts().at(-1)?.session, readSession);
    assertEquals(f.initializations(), 3);
    assertEquals(f.state.acceptedPosts, 2);
    console.log(
      JSON.stringify({
        gate: "R1-fresh-send",
        freshInitializations: 2,
        freshCatalogs: 2,
        sendCalls: 2,
        acceptedPosts: 2,
        retainedReadSessions: 1,
      }),
    );
  } finally {
    await f.close();
  }
});

Deno.test("warm pooled session plus relay downtime fails before send dispatch; recovery posts once", async () => {
  const f = await recoveryFixture();
  try {
    f.state.sendSucceeds = true;
    await f.relay.wait(42, 10, 300);
    assertEquals(f.sessions.sessionCount, 1);
    await f.stopListener();
    const before = f.state.outbound.length;
    const failure = await assertRejects(
      () => f.relay.send(42, "restart-post"),
      RelayFailure,
    );
    assertEquals(failure.kind, "pre_dispatch");
    assertEquals(failure.retrySafe, true);
    assertEquals(
      f.state.outbound.slice(before).filter((r) => r.method === "tools/call")
        .length,
      0,
    );
    assertEquals(
      f.state.outbound.slice(before).filter((r) => r.method === "initialize")
        .length,
      1,
    );
    assertEquals(f.state.acceptedPosts, 0);
    f.restartListener();
    f.state.now = f.relay.health.retryAt;
    assertEquals((await f.relay.send(42, "restart-post")).message_id, 101);
    assertEquals(f.state.acceptedPosts, 1);
    assertEquals(
      f.attempts().filter((r) => r.name === "send_message").length,
      1,
    );
    console.log(
      JSON.stringify({
        gate: "R1-warm-down-recovery",
        warmReadSessions: 1,
        downSendCalls: 0,
        downInitializes: 1,
        retrySafe: true,
        recoveryAcceptedPosts: 1,
      }),
    );
  } finally {
    await f.close();
  }
});

Deno.test("successful fresh send keeps its primary result if owned disposal fails", async () => {
  class FailingCloseClient extends Client {
    override async close() {
      await super.close();
      throw new Error("j2-send-cleanup-failure");
    }
  }
  const f = await recoveryFixture(() =>
    new FailingCloseClient({ name: "j2-send-close", version: "1" })
  );
  try {
    f.state.sendSucceeds = true;
    assertEquals(await f.relay.send(42, "accepted-before-cleanup"), {
      message_id: 101,
      chat_id: 42,
      state: "sent",
    });
    assertEquals(f.state.acceptedPosts, 1);
    assertEquals(f.relay.cleanupFailures, 1);
    assertEquals(f.sessions.sessionCount, 0);
    assertEquals(
      (await assertRejects(() => f.relay.close(), RelayShutdownFailure))
        .failures,
      1,
    );
    console.log(
      JSON.stringify({
        gate: "R1-success-cleanup",
        primaryMessageId: 101,
        acceptedPosts: 1,
        cleanupFailures: 1,
        shutdownRejected: true,
        retrySuggested: false,
      }),
    );
  } finally {
    await assertRejects(() => f.close(), AggregateError);
  }
});
