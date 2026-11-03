// SPDX-License-Identifier: LGPL-3.0-only
// Child-process crash/concurrency fixture. Only its caller-provided test DB.
import { openSqlite } from "../../sqlite.ts";
import { RegistryWriter } from "../../registry.ts";

const [path, mode, prefix, count = "1"] = Deno.args;
const db = await openSqlite(path);
const input = Deno.stdin.readable.pipeThrough(new TextDecoderStream())
  .getReader();
const pause = async () => {
  await input.read();
};
console.log("START");
try {
  for (let i = 0; i < Number(count); i++) {
    db.exec("BEGIN IMMEDIATE");
    const tx = new RegistryWriter(db);
    tx.putSubscription({
      session_id: `ses_${prefix}${i}`,
      relay: "test@example.invalid",
      chat_id: 42,
      directory: `/test/${prefix}${i}`,
      owner_server: "http://127.0.0.1:4097/",
      alias: "fixture",
      state: "active",
      anchor_id: 10,
      recent_ids: [10],
      created_at: 1,
      updated_at: 1,
      left_at: null,
    });
    tx.finish();
    if (mode === "pre") {
      console.log("PRE");
      await pause();
    }
    db.exec("COMMIT");
    if (mode === "post") {
      console.log("POST");
      await pause();
    }
  }
  console.log("DONE");
} finally {
  await input.cancel();
  input.releaseLock();
  db.close();
}
