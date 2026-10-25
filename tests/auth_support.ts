// SPDX-License-Identifier: LGPL-3.0-only
import { pathfinder } from "@pathfinder/pathfinder";
import { AuthState, loadRuntimeConfig } from "../src/auth/state.ts";
import { ApiKeys } from "../src/auth/api-keys.ts";
import { createLog } from "../src/log.ts";
import { openStateDb } from "../src/state/db.ts";
import { fixture } from "./support.ts";

export async function authFixture(
  env: Record<string, string> = {},
  now: () => number = Date.now,
) {
  const dir = await fixture("auth");
  const { cfg, secretPinned } = loadRuntimeConfig({
    DCMCP_DATA_DIR: dir,
    ...env,
  });
  const logs: string[] = [];
  const log = createLog("debug", [], (line) => logs.push(line));
  const auth = await AuthState.open(cfg, {
    log,
    secretPinned,
    now,
    qr: (text) => Promise.resolve(`<svg>${text}</svg>`),
  });
  const db = openStateDb(dir);
  const apiKeys = new ApiKeys(db, now, (values) => log.registerSecrets(values));
  const app = await pathfinder({
    roots: [new URL("../src/http/routes/", import.meta.url)],
    app: {
      auth,
      apiKeys,
      log,
      mcp: {
        handleRequest: () => Promise.resolve(Response.json({ accepted: true })),
      },
    },
  });
  return {
    dir,
    cfg,
    auth,
    apiKeys,
    db,
    logs,
    log,
    app,
    close: () => db.close(),
  };
}
export async function publicAuth() {
  const dir = await fixture("mcp-auth");
  const { cfg } = loadRuntimeConfig({
    DCMCP_DATA_DIR: dir,
    DCMCP_AUTH_TYPE: "public",
  });
  return await AuthState.open(cfg, {
    log: createLog("error", [], () => {}),
    qr: () => Promise.reject(new Error("Not used in MCP spike")),
  });
}
