// SPDX-License-Identifier: LGPL-3.0-only
import { assertWitnessChildProfile } from "./owner_witness_profile.ts";
import {
  captureOwnerWitness,
  parseOwnerWitness,
  probeOwner,
} from "../../integrations/opencode/owner-witness.ts";
import { deadline } from "../support.ts";

const profile = assertWitnessChildProfile();
const witness = captureOwnerWitness();
if (!witness) throw new Error("Authorized process witness profile unavailable");
if (Deno.args[0] !== "driver") {
  console.log(JSON.stringify(witness));
  await Deno.stdin.read(new Uint8Array(1));
} else {
  if (probeOwner(witness) !== "alive") {
    throw new Error("Self witness must be alive");
  }
  // Deno's special-file guard requires -A for /proc/self even with --allow-read.
  // Both processes enforce the same exact guest profile; normal hook environment
  // inheritance (including TMPDIR/M0_TREE) and suite permissions stay intact.
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL(import.meta.url).pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const reader = child.stdout.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const part = await deadline(reader.read());
      if (part.done) throw new Error("Child exited without witness");
      text += new TextDecoder().decode(part.value);
    }
    const other = parseOwnerWitness(JSON.parse(text.trim()));
    if (!other || other.pid !== child.pid || probeOwner(other) !== "alive") {
      throw new Error("Waiting child identity must be alive");
    }
    await child.stdin.close();
    const status = await deadline(child.status);
    const stderr = await new Response(child.stderr).text();
    if (status.code !== 0) {
      throw new Error(stderr);
    }
    if (probeOwner(other) !== "dead") {
      throw new Error("Reaped exact child identity must be dead");
    }
    console.log(
      JSON.stringify({
        profile,
        self: "alive",
        waiting: "alive",
        reaped: "dead",
        witness: other,
      }),
    );
  } finally {
    try {
      await child.stdin.close();
    } catch { /* already closed */ }
    await deadline(child.status);
    while (!(await reader.read()).done) { /* drain the same owned reader */ }
    reader.releaseLock();
  }
}
