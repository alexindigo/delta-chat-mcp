// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { pathfinder } from "@pathfinder/pathfinder";
import { startService } from "../../src/service.ts";
import { loadConfig } from "../../src/config.ts";
import { fixture } from "../support.ts";
import { createLog } from "../../src/log.ts";
import { EventStreams } from "../../src/http/event-streams.ts";
import { ChangeHub } from "../../src/events.ts";
import { authFixture } from "../auth_support.ts";

Deno.test("native stream provenance accepts same-origin Referer, rejects cross-origin and requires cookie; logout closes it", async () => {
  const f = await authFixture();
  const streams = new EventStreams(new ChangeHub(), f.auth);
  try {
    const token = await f.auth.setup({
      type: "password",
      username: "operator",
      password: "private-fixture",
    });
    const cookie = f.auth.cookie(token!).split(";")[0];
    const route = await pathfinder({
      roots: [new URL("../../src/http/routes/", import.meta.url)],
      app: { auth: f.auth, apiKeys: f.apiKeys, log: f.log, streams },
    });
    const req = (headers: Record<string, string>) =>
      new Request("http://relay/api/events", {
        headers: { accept: "text/event-stream", ...headers },
      });
    for (
      const headers of [{ cookie, referer: "http://evil/" }, { cookie }, {
        cookie,
        origin: "http://evil",
        referer: "http://relay/",
      }] as Record<string, string>[]
    ) assertEquals((await route(req(headers))).status, 403);
    assertEquals((await route(req({ referer: "http://relay/" }))).status, 401);
    const response = await route(
      req({ cookie, referer: "http://relay/contacts" }),
    );
    assertEquals(response.status, 200);
    const reader = response.body!.getReader();
    await reader.read();
    assertEquals(streams.size, 1);
    const logout = await route(
      new Request("http://relay/api/auth/logout", {
        method: "POST",
        headers: { cookie, origin: "http://relay" },
      }),
    );
    assertEquals(logout.status, 204);
    assertEquals((await reader.read()).done, true);
    assertEquals(streams.size, 0);
  } finally {
    streams.close();
    f.close();
  }
});

Deno.test("messaging routes share services, GET never marks seen and typed inputs are bounded", async () => {
  const service = await startService(
    loadConfig({
      env: {
        DCMCP_DATA_DIR: await fixture("m3-routes"),
        DCMCP_LISTEN_PORT: "0",
        DCMCP_AUTH_TYPE: "public",
      },
    }),
    { log: createLog("error", [], () => {}) },
  );
  try {
    const app = service.app;
    const calls: unknown[] = [];
    app.account.status = () =>
      Promise.resolve({
        configured: true,
        accountId: 7,
        address: "fixture@relay",
        displayName: "Fixture",
        connectivity: 4000,
      });
    app.chats.messages = (chat, range) => {
      calls.push(["messages", chat, range]);
      return Promise.resolve([]);
    };
    app.chats.markPresented = (chat, ids) => {
      calls.push(["seen", chat, ids]);
      return Promise.resolve();
    };
    app.contacts.openChat = (contact) => {
      calls.push(["open", contact]);
      return Promise.resolve({ chatId: 9 });
    };
    const route = await pathfinder({
      roots: [new URL("../../src/http/routes/", import.meta.url)],
      app,
    });
    const get = (path: string, method = "GET", body?: unknown) =>
      route(
        new Request(`http://relay${path}`, {
          method,
          ...(body === undefined ? {} : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        }),
      );
    assertEquals((await (await get("/api/account")).json()).connectivity, 4000);
    assertEquals((await get("/api/chats/9/messages?limit=30")).status, 200);
    assertEquals(calls, [["messages", 9, { limit: 30 }]]);
    assertEquals(
      (await get("/api/chats/9/seen", "POST", { ids: [5, 6] })).status,
      200,
    );
    assertEquals((await get("/api/contacts/42/chat", "POST")).status, 200);
    assertEquals(calls.slice(1), [["seen", 9, [5, 6]], ["open", 42]]);
    for (
      const path of [
        "/api/chats/9/messages?limit=1001",
        "/api/chats/9007199254740993/messages",
        "/api/chats/9/messages?afterId=0",
        "/api/chats/9/messages?unknown=x",
      ]
    ) assertEquals((await get(path)).status, 400);
    assertEquals(
      (await get("/api/chats/9/seen", "POST", { ids: [0] })).status,
      400,
    );
    assertEquals(calls.length, 3);
    assert(
      (await get("/api/account")).headers.get("cache-control")?.includes(
        "no-store",
      ),
    );
  } finally {
    await service.close();
  }
});
