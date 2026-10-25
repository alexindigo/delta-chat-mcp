// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { fixture } from "../support.ts";

Deno.test("configuration merges leaves defaults then TOML then environment", async () => {
  const dir = await fixture("config");
  const path = `${dir}/config.toml`;
  await Deno.writeTextFile(
    path,
    '[listen]\nport = 9001\n[log]\nlevel = "warn"\n',
  );
  const cfg = loadConfig({
    env: { DCMCP_CONFIG: path, DCMCP_LISTEN_PORT: "9002" },
  });
  assertEquals(cfg.listen, { hostname: "0.0.0.0", port: 9002 });
  assertEquals(cfg.log.level, "warn");
  assertEquals(cfg.mcp.waitMaxSeconds, 600);
});
Deno.test("strict configuration rejects unknown sections, wrong TOML types and malformed env", async () => {
  const dir = await fixture("config");
  const path = `${dir}/config.toml`;
  await Deno.writeTextFile(path, '[listen]\nport = "8080"\n[unknown]\nx=1\n');
  const error = assertThrows(() =>
    loadConfig({
      env: {
        DCMCP_CONFIG: path,
        DCMCP_MCP_WAITMAXSECONDS: "1.2",
        DCMCP_LISTEN: "x",
        DCMCP_AUTH_TYPO: "secret",
      },
    }), ConfigError);
  for (
    const expected of [
      "DCMCP_LISTEN_PORT",
      "DCMCP_UNKNOWN",
      "DCMCP_MCP_WAITMAXSECONDS",
      "DCMCP_LISTEN",
      "DCMCP_AUTH_TYPO",
    ]
  ) assert(error.message.includes(expected));
  assert(!error.message.includes("secret"));
});
Deno.test("incomplete shipped defaults report missing leaves even if env supplies them", async () => {
  const dir = await fixture("config");
  const path = `${dir}/broken.toml`;
  await Deno.writeTextFile(path, '[listen]\nhostname="0.0.0.0"\n');
  const error = assertThrows(
    () =>
      loadConfig({ defaultsPath: path, env: { DCMCP_LISTEN_PORT: "8080" } }),
    ConfigError,
  );
  assert(error.message.includes("listen.port (DCMCP_LISTEN_PORT): missing"));
  assert(error.message.includes("auth.type (DCMCP_AUTH_TYPE): missing"));
});
