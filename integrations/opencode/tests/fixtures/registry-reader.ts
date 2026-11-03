// SPDX-License-Identifier: LGPL-3.0-only
// Candidate keeper contract, builtin-only and read-only. No product keeper yet.
import { DatabaseSync } from "node:sqlite";
const [path, owner] = Deno.args;
const db = new DatabaseSync(path, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout=10000; BEGIN");
  const version = db.prepare("SELECT version FROM schema_version").all();
  if (version.length !== 1 || version[0].version !== 1) {
    throw new Error("Unsupported schema");
  }
  const rows = db.prepare(
    "SELECT directory FROM keeper_directories WHERE owner_server=? ORDER BY directory",
  ).all(owner);
  let writeRejected = false;
  try {
    db.exec("UPDATE schema_version SET version=1 WHERE version=1");
  } catch (error) {
    if (
      !(error instanceof Error) || !/readonly|read-only/i.test(error.message)
    ) throw new Error("Unexpected write failure class");
    writeRejected = true;
  }
  if (!writeRejected) throw new Error("Read-only write unexpectedly succeeded");
  db.exec("COMMIT");
  console.log(
    JSON.stringify({
      branch: "readOnly:true",
      writeRejected,
      directories: rows.map((r) => r.directory),
    }),
  );
} finally {
  db.close();
}
