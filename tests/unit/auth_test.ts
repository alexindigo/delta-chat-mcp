// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { authenticator } from "otplib";
import { SignJWT } from "jose";
import { AuthState, loadRuntimeConfig } from "../../src/auth/state.ts";
import { authFixture } from "../auth_support.ts";

const origin = "http://delta-chat-mcp.test:8080";
function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined
        ? {}
        : { "content-type": "application/json", origin }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const cookie = (response: Response) =>
  response.headers.get("set-cookie")!.split(";")[0];

Deno.test("unconfigured access returns 503 while public session/setup/login remain discoverable", async () => {
  const f = await authFixture();
  try {
    for (const req of [request("/mcp"), request("/api/auth/logout", {})]) {
      const result = await f.app(req);
      assertEquals(result.status, 503);
      await result.body?.cancel();
    }
    const result = await f.app(request("/api/auth/session"));
    assertEquals((await result.json()).setupRequired, true);
  } finally {
    f.close();
  }
});
Deno.test("password setup is no-overwrite/race-safe with private permissions and hashed-only state", async () => {
  const f = await authFixture();
  try {
    const results = await Promise.all([
      f.app(
        request("/api/auth/setup", {
          type: "password",
          username: "operator",
          password: "fixture-password",
        }),
      ),
      f.app(
        request("/api/auth/setup", {
          type: "password",
          username: "racer",
          password: "other-password",
        }),
      ),
    ]);
    assertEquals(results.map((response) => response.status).sort(), [200, 409]);
    for (const response of results) await response.body?.cancel();
    assertEquals((await Deno.stat(f.dir)).mode! & 0o777, 0o700);
    assertEquals((await Deno.stat(`${f.dir}/auth.toml`)).mode! & 0o777, 0o600);
    const stored = await Deno.readTextFile(`${f.dir}/auth.toml`);
    assert(stored.includes("pbkdf2_sha256$100000$"));
    assert(!stored.includes("fixture-password"));
    assert(!stored.includes("other-password"));
    assertEquals(
      (await f.app(request("/api/auth/setup", { type: "public" }))).status,
      409,
    );
  } finally {
    f.close();
  }
});
Deno.test("browser password login cookies, Origin gates and logout obey plain-HTTP contract", async () => {
  const f = await authFixture();
  try {
    await f.auth.setup({
      type: "password",
      username: "operator",
      password: "fixture-password",
    });
    const bad = await f.app(
      request("/api/auth/login", { username: "operator", password: "wrong" }),
    );
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
    const login = await f.app(
      request("/api/auth/login", {
        username: "operator",
        password: "fixture-password",
      }),
    );
    assertEquals(login.status, 200);
    await login.body?.cancel();
    const header = login.headers.get("set-cookie")!;
    for (
      const attribute of [
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=2592000",
      ]
    ) assert(header.includes(attribute));
    assert(!header.includes("Secure"));
    const browser = cookie(login);
    const foreign = await f.app(
      request("/api/auth/logout", {}, {
        cookie: browser,
        origin: "http://foreign.test",
      }),
    );
    assertEquals(foreign.status, 403);
    await foreign.body?.cancel();
    const absent = new Request(origin + "/api/auth/logout", {
      method: "POST",
      headers: { cookie: browser },
    });
    const denied = await f.app(absent);
    assertEquals(denied.status, 403);
    await denied.body?.cancel();
    const session = await f.app(
      request("/api/auth/session", undefined, { cookie: browser }),
    );
    assertEquals((await session.json()).authenticated, true);
    const logout = await f.app(
      request("/api/auth/logout", {}, { cookie: browser }),
    );
    assertEquals(logout.status, 204);
    assert(logout.headers.get("set-cookie")!.includes("Max-Age=0"));
  } finally {
    f.close();
  }
});
Deno.test("TOTP enrollment confirmation and accepted steps cannot replay concurrently or after restart", async () => {
  let now = 1700000000000;
  const f = await authFixture({}, () => now);
  try {
    const key = "JBSWY3DPEHPK3PXP";
    const code = () => {
      const otp = authenticator.clone();
      otp.options = { epoch: now };
      return otp.generate(key);
    };
    await f.auth.setup({
      type: "totp",
      username: "operator",
      password: "fixture-password",
      totpkey: key,
      code: code(),
    });
    await assertRejects(
      () => f.auth.login("operator", "fixture-password", code()),
      Error,
      "Incorrect",
    );
    now += 30000;
    const results = await Promise.allSettled([
      f.auth.login("operator", "fixture-password", code()),
      f.auth.login("operator", "fixture-password", code()),
    ]);
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assertEquals(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const { cfg } = loadRuntimeConfig({ DCMCP_DATA_DIR: f.dir });
    const reopened = await AuthState.open(cfg, {
      log: f.log,
      now: () => now,
      qr: () => Promise.resolve("<svg/>"),
    });
    await assertRejects(
      () => reopened.login("operator", "fixture-password", code()),
      Error,
      "Incorrect",
    );
    assert(!f.logs.join("").includes(key));
  } finally {
    f.close();
  }
});
Deno.test("API keys are shown once, stored only as digests and revoked even for known session headers", async () => {
  const f = await authFixture();
  try {
    const token = await f.auth.setup({
      type: "password",
      username: "operator",
      password: "fixture-password",
    });
    const created = await f.apiKeys.create("Fixture key");
    assert(/^dcm_[A-Za-z0-9_-]{43}$/.test(created.key));
    const row = f.db.prepare("SELECT * FROM api_keys").get()!;
    assertEquals(row.digest, created.id);
    assert(!JSON.stringify(row).includes(created.key));
    assert(!JSON.stringify(f.apiKeys.list()).includes(created.key));
    const headers = {
      authorization: `Bearer ${created.key}`,
      "mcp-session-id": "already-known-session",
    };
    const allowed = await f.app(request("/mcp", undefined, headers));
    assertEquals(allowed.status, 200);
    await allowed.body?.cancel();
    assert(f.apiKeys.list()[0].lastUsed !== null);
    const cookieOnly = await f.app(
      request("/mcp", undefined, { cookie: f.auth.cookie(token!) }),
    );
    assertEquals(cookieOnly.status, 401);
    await cookieOnly.body?.cancel();
    const bearerOnly = await f.app(
      request("/api/auth/logout", {}, {
        authorization: `Bearer ${created.key}`,
      }),
    );
    assertEquals(bearerOnly.status, 401);
    await bearerOnly.body?.cancel();
    let revoked = "";
    const off = f.apiKeys.subscribeRevoked((id) => {
      revoked = id;
    });
    f.apiKeys.delete(created.id);
    off();
    assertEquals(revoked, created.id);
    const deleted = await f.app(request("/mcp", undefined, headers));
    assertEquals(deleted.status, 401);
    assertEquals(deleted.headers.get("www-authenticate"), "Bearer");
    await deleted.body?.cancel();
    assertEquals(f.apiKeys.list(), []);
  } finally {
    f.close();
  }
});
Deno.test("environment password wins over auth.toml and rotates signing key to invalidate old sessions", async () => {
  const f = await authFixture();
  try {
    const token = await f.auth.setup({
      type: "password",
      username: "operator",
      password: "first-password",
    });
    const oldCookie = f.auth.cookie(token!);
    const before = await Deno.readTextFile(`${f.dir}/auth.toml`);
    const { cfg, secretPinned } = loadRuntimeConfig({
      DCMCP_DATA_DIR: f.dir,
      DCMCP_AUTH_PASSWORD: "second-password",
    });
    const changed = await AuthState.open(cfg, {
      log: f.log,
      secretPinned,
      qr: () => Promise.resolve("<svg/>"),
    });
    await assertRejects(
      () => changed.login("operator", "first-password"),
      Error,
      "Incorrect",
    );
    assert(await changed.login("operator", "second-password"));
    assertEquals(
      await changed.authenticated(
        request("/api/auth/session", undefined, { cookie: oldCookie }),
      ),
      false,
    );
    assert((await Deno.readTextFile(`${f.dir}/auth.toml`)) !== before);
    const restored = await AuthState.open(
      loadRuntimeConfig({ DCMCP_DATA_DIR: f.dir }).cfg,
      {
        log: f.log,
        qr: () => Promise.resolve("<svg/>"),
      },
    );
    assert(await restored.login("operator", "first-password"));
    await assertRejects(
      () => restored.login("operator", "second-password"),
      Error,
      "Incorrect",
    );
  } finally {
    f.close();
  }
});
Deno.test("public mode opens both subtrees and warns without needing a key or cookie", async () => {
  const f = await authFixture({ DCMCP_AUTH_TYPE: "public" });
  try {
    const mcp = await f.app(request("/mcp"));
    assertEquals(mcp.status, 200);
    await mcp.body?.cancel();
    const api = await f.app(request("/api/auth/logout", {}));
    assertEquals(api.status, 204);
    assert(f.logs.some((line) => JSON.parse(line).event === "public_access"));
  } finally {
    f.close();
  }
});
Deno.test("independent first-run setup writers cannot overwrite the published credentials", async () => {
  const f = await authFixture();
  try {
    const second = await AuthState.open(f.cfg, {
      log: f.log,
      qr: () => Promise.resolve("<svg/>"),
    });
    const results = await Promise.allSettled([
      f.auth.setup({
        type: "password",
        username: "first",
        password: "first-password",
      }),
      second.setup({
        type: "password",
        username: "second",
        password: "second-password",
      }),
    ]);
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const before = await Deno.readTextFile(`${f.dir}/auth.toml`);
    const loser = results[0].status === "rejected" ? f.auth : second;
    await assertRejects(
      () => loser.setup({ type: "public" }),
      Error,
      "Already configured",
    );
    assertEquals(await Deno.readTextFile(`${f.dir}/auth.toml`), before);
  } finally {
    f.close();
  }
});
Deno.test("explicitly pinned signing keys must rotate with changed credentials", async () => {
  const f = await authFixture({
    DCMCP_AUTH_TYPE: "password",
    DCMCP_AUTH_USERNAME: "operator",
    DCMCP_AUTH_PASSWORD: "first-password",
    DCMCP_AUTH_SECRETKEY: "a".repeat(64),
  });
  try {
    const token = await f.auth.login("operator", "first-password");
    const base = {
      DCMCP_DATA_DIR: f.dir,
      DCMCP_AUTH_PASSWORD: "second-password",
      DCMCP_AUTH_SECRETKEY: "a".repeat(64),
    };
    const same = loadRuntimeConfig(base);
    await assertRejects(
      () =>
        AuthState.open(same.cfg, {
          secretPinned: same.secretPinned,
          log: f.log,
          qr: () => Promise.resolve("<svg/>"),
        }),
      Error,
      "rotating",
    );
    const next = loadRuntimeConfig({
      ...base,
      DCMCP_AUTH_SECRETKEY: "b".repeat(64),
    });
    const changed = await AuthState.open(next.cfg, {
      secretPinned: next.secretPinned,
      log: f.log,
      qr: () => Promise.resolve("<svg/>"),
    });
    assert(await changed.login("operator", "second-password"));
    assertEquals(
      await changed.authenticated(
        request("/api/auth/session", undefined, {
          cookie: f.auth.cookie(token!),
        }),
      ),
      false,
    );
  } finally {
    f.close();
  }
});
Deno.test("browser verification is pinned to HS256 rather than another valid HMAC algorithm", async () => {
  const secret = "a".repeat(64);
  const f = await authFixture({
    DCMCP_AUTH_TYPE: "password",
    DCMCP_AUTH_USERNAME: "operator",
    DCMCP_AUTH_PASSWORD: "fixture-password",
    DCMCP_AUTH_SECRETKEY: secret,
  });
  try {
    const wrongAlgorithm = await new SignJWT({ sub: "operator" })
      .setProtectedHeader({ alg: "HS384" }).setIssuedAt().setExpirationTime(
        Math.floor(Date.now() / 1000) + 3600,
      ).sign(new TextEncoder().encode(secret));
    assertEquals(
      await f.auth.authenticated(
        request("/api/auth/session", undefined, {
          cookie: f.auth.cookie(wrongAlgorithm),
        }),
      ),
      false,
    );
  } finally {
    f.close();
  }
});
