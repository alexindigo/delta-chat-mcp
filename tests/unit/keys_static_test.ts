// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { authFixture } from "../auth_support.ts";
import { fixture } from "../support.ts";
import { staticResponse } from "../../src/http/static.ts";

Deno.test("key CRUD accepts only browser cookie, shows secret once and deletes its ability to authenticate", async () => {
  const f = await authFixture();
  try {
    const token = await f.auth.setup({
      type: "password",
      username: "operator",
      password: "fixture-password",
    });
    const cookie = f.auth.cookie(token!).split(";")[0];
    const request = (
      path = "/api/keys",
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      f.app(
        new Request(`http://delta-chat-mcp.test${path}`, {
          method,
          headers: {
            Origin: "http://delta-chat-mcp.test",
            Cookie: cookie,
            "content-type": "application/json",
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const created = await request("/api/keys", "POST", {
      name: "Session agent",
    });
    assertEquals(created.status, 201);
    assertEquals(created.headers.get("cache-control"), "no-store");
    const key = await created.json();
    const bearer = { Authorization: `Bearer ${key.key}` };
    const unauthorized = await request("/api/keys", "GET", undefined, {
      Cookie: "",
      ...bearer,
    });
    assertEquals(unauthorized.status, 401);
    assertEquals(
      await f.apiKeys.authenticate(
        new Request("http://fixture/mcp", { headers: bearer }),
      ),
      key.id,
    );
    const listed = await (await request()).json();
    assertEquals(listed.keys.length, 1);
    assert(!JSON.stringify(listed).includes(key.key));
    assert(listed.keys[0].lastUsed);
    const csrf = await request(`/api/keys/${key.id}`, "DELETE", undefined, {
      Origin: "http://other.test",
    });
    assertEquals(csrf.status, 403);
    assert(f.apiKeys.has(key.id));
    assertEquals((await request(`/api/keys/${key.id}`, "DELETE")).status, 204);
    assertEquals(
      await f.apiKeys.authenticate(
        new Request("http://fixture/mcp", { headers: bearer }),
      ),
      null,
    );
    for (const path of ["/api/missing", "/mcp/missing"]) {
      const response = await request(path);
      assertEquals(response.status, 404);
      assert(response.headers.get("content-type")?.includes("json"));
    }
  } finally {
    f.close();
  }
});

Deno.test("static owner serves built MIME, SPA navigation only and rejects reserved paths, traversal, missing assets and escaping symlinks", async () => {
  const root = await fixture("static"),
    outside = await fixture("static-outside");
  await Deno.writeTextFile(`${root}/index.html`, "<main>relay</main>");
  await Deno.writeTextFile(`${root}/bundle.js`, "export const ready=true");
  await Deno.writeTextFile(`${outside}/private.html`, "private");
  await Deno.symlink(`${outside}/private.html`, `${root}/escape.html`);
  const get = (path: string) =>
    staticResponse(new Request(`http://delta-chat-mcp.test${path}`), root);
  assertEquals(await (await get("/keys")).text(), "<main>relay</main>");
  assert(
    (await get("/bundle.js")).headers.get("content-type")?.includes(
      "javascript",
    ),
  );
  for (
    const path of [
      "/api/missing",
      "/mcp",
      "/_/health",
      "/_status",
      "/assets/missing.js",
      "/escape.html",
      "/%2e%2e%2fprivate.html",
      "/%E0%A4%A",
    ]
  ) assertEquals((await get(path)).status, 404, path);
});
