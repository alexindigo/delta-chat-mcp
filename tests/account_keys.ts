// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { parse } from "@std/toml";
import { DatabaseSync } from "node:sqlite";

/** Inspect actual persisted public keys; never read/export private key material. */
export async function publicKeys(accountsDir: string) {
  const config = parse(await Deno.readTextFile(`${accountsDir}/accounts.toml`));
  const accounts = config.accounts as { dir: string }[];
  assertEquals(accounts.length, 1);
  const db = new DatabaseSync(`${accountsDir}/${accounts[0].dir}/dc.db`, {
    readOnly: true,
  });
  try {
    return db.prepare("SELECT public_key FROM keypairs ORDER BY id").all();
  } finally {
    db.close();
  }
}
