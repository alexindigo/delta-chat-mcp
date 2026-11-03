// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Relay, RelayFailure } from "../../integrations/opencode/relay.ts";
import { startService } from "../../src/service.ts";
import { McpSessions } from "../../src/mcp/sessions.ts";
import { McpServer } from "@modelcontextprotocol/server";
import { pathfinder } from "@pathfinder/pathfinder";
import { z } from "zod";
import { authFixture } from "../auth_support.ts";
import { loadRuntimeConfig } from "../../src/auth/state.ts";
import { createLog } from "../../src/log.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";

export async function runC25() {
  const { cfg } = loadRuntimeConfig({
    DCMCP_DATA_DIR: await fixture("opencode-relay"),
    DCMCP_LISTEN_PORT: "0",
    DCMCP_AUTH_TYPE: "password",
    DCMCP_AUTH_USERNAME: "test",
    DCMCP_AUTH_PASSWORD: "j2-test-only",
    DCMCP_MCP_WAITMAXSECONDS: "5",
  });
  const service = await startService(cfg, {
    log: createLog("error", [], () => {}),
  });
  const url = `http://${lanAddress()}:${service.addr.port}/mcp`;
  const first = await service.app.apiKeys.create("j2-first");
  const second = await service.app.apiKeys.create("j2-second");
  const clients: Relay[] = [];
  let clock = Date.now(), enabled = true, sessionID: string | undefined;
  let expireFreshSend = false;
  let closeBeforeSend = false;
  const calls: { method?: string; name?: string; seconds?: number }[] = [];
  const observedFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      calls.push({
        method: body.method,
        name: body.params?.name,
        seconds: body.params?.arguments?.timeout_seconds,
      });
      if (
        expireFreshSend && body.method === "tools/call" &&
        body.params?.name === "send_message"
      ) {
        expireFreshSend = false;
        const headers = new Headers(init.headers);
        const expired = await fetch(input, { method: "DELETE", headers });
        assert(expired.ok);
        await expired.body?.cancel();
      }
      if (
        closeBeforeSend && body.method === "tools/call" &&
        body.params?.name === "send_message"
      ) {
        closeBeforeSend = false;
        await (service.app.mcp as McpSessions).close();
      }
    }
    const response = await fetch(input, init);
    sessionID = response.headers.get("mcp-session-id") ?? sessionID;
    return response;
  };
  const make = (endpoint: string, key = first.key) => {
    const client = new Relay(
      {
        alias: "fixture",
        url: endpoint,
        headers: { Authorization: `Bearer ${key}` },
        enabled: true,
      },
      { enabled: () => Promise.resolve(enabled) },
      observedFetch,
      () => clock,
    );
    clients.push(client);
    return client;
  };
  const failure = async (
    operation: () => Promise<unknown>,
    kind: string,
    safe: boolean,
  ) => {
    const error = await assertRejects(operation, RelayFailure);
    assertEquals(error.kind, kind);
    assertEquals(error.retrySafe, safe);
    return { kind: error.kind, retrySafe: error.retrySafe };
  };
  let forwardedSends = 0;
  const proxy = Deno.serve({
    hostname: lanAddress(),
    port: 0,
    onListen() {},
    onError: () => new Response(null, { status: 500 }),
  }, async (request) => {
    const body = request.method === "POST" ? await request.text() : undefined;
    const parsed = body ? JSON.parse(body) : undefined;
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body,
    });
    if (
      parsed?.method === "tools/call" && parsed.params?.name === "send_message"
    ) {
      // Actual relay has finished handling the request, but no result reaches
      // the caller. Break the response stream after HTTP200 headers were sent.
      await response.arrayBuffer();
      forwardedSends++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("event: message\ndata: "),
            );
            setTimeout(
              () => controller.error(new Error("j2-owned-response-loss")),
              20,
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return response;
  });
  try {
    const refusalSocket = Deno.listen({ hostname: lanAddress(), port: 0 });
    const refusedURL = `http://${lanAddress()}:${refusalSocket.addr.port}/mcp`;
    refusalSocket.close();
    const refused = await failure(
      () => make(refusedURL).send(42, "C25-refused"),
      "pre_dispatch",
      true,
    );
    const direct = make(url);
    await direct.call("status", {});
    // Real advertised schema clamp: the actual transmitted timeout is five.
    await failure(() => direct.wait(42, 10, 300), "tool_error", false);
    assertEquals(
      calls.findLast((c) => c.name === "wait_for_messages")?.seconds,
      5,
    );
    clock += 61_000;
    await direct.call("status", {});
    assert(sessionID);
    // Expire the send's NEW native session after its catalog was read, before
    // its only tools/call. An old pooled session must never be used for sends.
    expireFreshSend = true;
    const stale = await failure(
      () => direct.send(42, "C25-expired"),
      "session_expired",
      true,
    );
    clock += 61_000;
    const initializedBefore = calls.filter((c) =>
      c.method === "initialize"
    ).length;
    // The real unconfigured relay returns an application error, proving the
    // replacement native session reached the tool rather than replaying404.
    await failure(
      () => direct.send(42, "C25-after-expired"),
      "uncertain",
      false,
    );
    assertEquals(
      calls.filter((c) => c.method === "initialize").length,
      initializedBefore + 1,
    );
    await direct.call("status", {});
    assert(calls.filter((c) => c.method === "initialize").length >= 3);
    service.app.apiKeys.delete(first.id);
    const unauthorized = await failure(
      () => direct.send(42, "C25-auth"),
      "auth_failed",
      true,
    );
    const before = calls.length;
    await failure(
      () => direct.send(42, "C25-no-auth-retry"),
      "auth_failed",
      true,
    );
    assertEquals(calls.length, before);
    const loss = make(
      `http://${lanAddress()}:${proxy.addr.port}/mcp`,
      second.key,
    );
    const uncertain = await failure(
      () => loss.send(42, "C25-response-loss", AbortSignal.timeout(3000)),
      "uncertain",
      false,
    );
    assertEquals(
      forwardedSends,
      1,
      "No SDK/adapter automatic resend after dispatch",
    );
    const closing = make(url, second.key);
    await closing.call("status", {});
    closeBeforeSend = true;
    const closed = await failure(
      () => closing.send(42, "C25-closing"),
      "closing",
      true,
    );
    enabled = false;
    const paused = await failure(
      () => closing.send(42, "C25-disabled"),
      "paused",
      false,
    );
    assertEquals(closing.health.state, "paused");
    console.log(JSON.stringify({
      gate: "C25",
      refused,
      unauthorized,
      stale,
      closed,
      uncertain,
      paused,
      forwardedSends,
      clampedSeconds: 5,
      native404Reinitialized: true,
      authFailedNoRetry: true,
      noBodiesPersisted: true,
    }));
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await proxy.shutdown();
    await service.close();
  }
}

Deno.test(
  "C25 real relay distinguishes pre-dispatch route rejection from post-request response loss without automatic mirror retries",
  runC25,
);

Deno.test("relay owns concurrent wait/send connections and cancels them on caller abort, native disable and disposal", async () => {
  const f = await authFixture({ DCMCP_AUTH_TYPE: "public" });
  let active = 0, sends = 0, enabled = true, requests = 0;
  const sessions = new McpSessions(f.apiKeys, (lifetime) => {
    const server = new McpServer({ name: "j2-wait-fixture", version: "1" });
    server.registerTool("wait_for_messages", {
      inputSchema: z.object({
        chat_id: z.number(),
        after_id: z.number(),
        timeout_seconds: z.number().int().max(2),
      }),
    }, async (_input, context) => {
      const signal = AbortSignal.any([lifetime, context.mcpReq.signal]);
      active++;
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else {signal.addEventListener("abort", () => resolve(), {
              once: true,
            });}
        });
        return {
          content: [{ type: "text", text: "{}" }],
          structuredContent: { timedOut: true, messages: [] },
        };
      } finally {
        active--;
      }
    });
    server.registerTool("send_message", {
      inputSchema: z.object({ chat_id: z.number(), text: z.string() }),
    }, () => {
      sends++;
      const data = { message_id: 100 + sends, chat_id: 42, state: "sent" };
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      };
    });
    return server;
  });
  const handler = await pathfinder({
    roots: [new URL("../../src/http/routes/", import.meta.url)],
    app: { auth: f.auth, apiKeys: f.apiKeys, mcp: sessions },
  });
  const http = Deno.serve(
    { hostname: lanAddress(), port: 0, onListen() {} },
    handler,
  );
  const relay = new Relay(
    {
      alias: "fixture",
      url: `http://${lanAddress()}:${http.addr.port}/mcp`,
      headers: {},
      enabled: true,
    },
    { enabled: () => Promise.resolve(enabled) },
    async (url, init) => {
      requests++;
      return await fetch(url, init);
    },
  );
  const catches = (error: unknown) => {
    assert(error instanceof RelayFailure);
    return error;
  };
  try {
    const abort = new AbortController();
    const waiting = relay.wait(42, 10, 300, abort.signal).catch(catches);
    await poll(() => active === 1);
    const sent = await deadline(
      relay.send(42, "fixture transport concurrency"),
      3000,
    );
    assertEquals(sent.message_id, 101);
    assertEquals(
      active,
      1,
      "Mirror connection must not wait behind long polling",
    );
    abort.abort();
    const cancelled = await deadline(waiting, 5000);
    assert(cancelled instanceof RelayFailure);
    assertEquals(cancelled.kind, "cancelled");
    await poll(() => active === 0);
    const pausedWait = relay.wait(42, 10, 300).catch(catches);
    await poll(() => active === 1);
    enabled = false;
    assertEquals(await deadline(relay.refreshNativeState(), 5000), false);
    const paused = await deadline(pausedWait, 5000);
    assert(paused instanceof RelayFailure);
    assertEquals(paused.kind, "paused");
    await poll(() => active === 0 && sessions.sessionCount === 0);
    const count = requests;
    await assertRejects(() => relay.send(42, "native disabled"), RelayFailure);
    assertEquals(requests, count);
    enabled = true;
    assertEquals((await relay.send(42, "re-enabled")).message_id, 102);
    await relay.close();
    assertEquals(sessions.sessionCount, 0);
    console.log(
      JSON.stringify({
        gate: "relay-lifetime",
        concurrentWaitAndSend: true,
        callerAbortReleasedWait: true,
        nativeDisableSessions: 0,
        disabledRequests: 0,
        reenabledSend: true,
        disposedSessions: 0,
      }),
    );
  } finally {
    await relay.close();
    await sessions.close();
    await http.shutdown();
    f.close();
  }
});
