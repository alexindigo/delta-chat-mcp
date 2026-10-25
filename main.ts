// SPDX-License-Identifier: LGPL-3.0-only

/** M0 configuration placeholder. The service lifecycle is implemented in M1. */
export function loadConfig() {
  return { dataDir: Deno.env.get("DCMCP_DATA_DIR") ?? "./data" };
}

if (import.meta.main) {
  loadConfig();
  console.log("delta-chat-mcp foundations; no service started yet.");
}
