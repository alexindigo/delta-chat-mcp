// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Access } from "../../web/src/access.ts";
import { Keys } from "../../web/src/keys.ts";
import { type Api, ApiError, type NewKey } from "../../web/src/api.ts";
import { openCodeConfig } from "../../web/src/location.ts";

Deno.test("access workflow preserves failed credentials input, confirms enrollment and clears secrets on accepted session", async () => {
  let submitted: Record<string, string> = {}, calls = 0;
  const session = {
    setupRequired: false,
    mode: "totp" as const,
    authenticated: true,
    username: "operator",
  };
  const api = {
    session: () =>
      Promise.resolve({
        ...session,
        setupRequired: true,
        authenticated: false,
      }),
    enroll: () =>
      Promise.resolve({ key: "ABC", uri: "otpauth://fixture", qr: "<svg/>" }),
    setup: (input: Record<string, string>) => {
      submitted = input;
      return Promise.resolve(session);
    },
    login: () => Promise.reject(new ApiError(401, "Incorrect credentials")),
  } as unknown as Api;
  const access = new Access(api, () => {}, () => {
    calls++;
  });
  await access.refresh();
  access.choose("totp");
  access.field("username", "operator");
  access.field("password", "fixture-password");
  await access.enroll();
  access.field("code", "123456");
  await access.submit();
  assertEquals(submitted.totpkey, "ABC");
  assertEquals(submitted.code, "123456");
  assertEquals(access.state.password, "");
  assertEquals(access.state.enrollment, null);
  assertEquals(calls, 2);
  access.field("password", "retryable-input");
  await access.submit();
  assertEquals(access.state.password, "retryable-input");
  assertEquals(access.state.error, "Incorrect credentials");
});

Deno.test("key workflow does not resurrect a shown-once credential after logout or obsolete async completion", async () => {
  const pending = Promise.withResolvers<NewKey>();
  const keys = new Keys(
    { createKey: () => pending.promise } as unknown as Api,
    () => Promise.resolve(),
    () => {},
    () => {},
  );
  keys.name("agent");
  const create = keys.create();
  keys.clear();
  pending.resolve({
    id: "fixture",
    key: "private-fixture-only",
    name: "agent",
    created: 1,
  });
  await create;
  assertEquals(keys.state.shown, null);
  assertEquals(keys.state.rows, []);
  assertEquals(keys.state.busy, false);
  const protectedConfig = openCodeConfig("http://relay.test:8080", false);
  assert(protectedConfig.includes("http://relay.test:8080/mcp"));
  assert(protectedConfig.includes("{env:DELTA_CHAT_MCP_KEY}"));
  const publicConfig = JSON.parse(
    openCodeConfig("http://relay.test:8080", true),
  );
  assertEquals(publicConfig.mcp["delta-chat"].oauth, false);
  assertEquals(publicConfig.mcp["delta-chat"].headers, undefined);
});
