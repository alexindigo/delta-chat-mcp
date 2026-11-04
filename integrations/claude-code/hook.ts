// SPDX-License-Identifier: LGPL-3.0-only
import { readFileSync } from "node:fs";
import { configuration } from "../conversations/config.ts";
import { Store } from "../conversations/store.ts";
import { immediate, openSqlite } from "../opencode/sqlite.ts";
import { hookEvent, nativeOwner, nativeSchema } from "./native.ts";

// The native host supplies this private plugin-data configuration path.
const config = configuration(JSON.parse(readFileSync(Deno.args[0], "utf8")));
const db = await openSqlite(config.stateFile);
try {
  const store = new Store(db);
  nativeSchema(db);
  const input = JSON.parse(await new Response(Deno.stdin.readable).text());
  immediate(db, () => hookEvent(store, nativeOwner(), input));
} finally {
  db.close();
}
