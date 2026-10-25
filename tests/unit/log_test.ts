// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createLog } from "../../src/log.ts";
Deno.test("central log redacts configured secrets, credential fields, bodies and raw errors", () => {
  const lines: string[] = [];
  const log = createLog("info", ["fixture-secret"], (line) => lines.push(line));
  log.event("debug", "ignored");
  log.event("info", "fixture", {
    detail: "prefix fixture-secret suffix",
    headers: { Authorization: "Bearer fixture-api", Cookie: "fixture-cookie" },
    nested: [{
      password: "fixture-password",
      api_key: "fixture-key",
      text: "fixture body",
      body: "fixture body",
      totpkey: "fixture-totp",
    }],
    error: new Error("fixture error body"),
  });
  assertEquals(lines.length, 1);
  for (
    const hidden of [
      "fixture-secret",
      "fixture-api",
      "fixture-cookie",
      "fixture-password",
      "fixture-key",
      "fixture body",
      "fixture-totp",
      "fixture error body",
    ]
  ) assert(!lines[0].includes(hidden));
  assertEquals(JSON.parse(lines[0]).fields.error, { name: "Error" });
  log.registerSecrets(["new-secret"]);
  log.event("warn", "rotation", { detail: "new-secret" });
  assertEquals(JSON.parse(lines[1]).fields.detail, "[redacted]");
});
