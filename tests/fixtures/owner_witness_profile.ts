// SPDX-License-Identifier: LGPL-3.0-only
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { getuid } from "node:process";

export interface WitnessChildFacts {
  host: string;
  uid: number | undefined;
  source: string;
  fstype: string;
  tmpdir: string | undefined;
  tree: string | undefined;
}
export type WitnessChildProfile = "manual-ct804" | "hook-ct802";
export function witnessChildProfile(
  facts: WitnessChildFacts,
): WitnessChildProfile | undefined {
  if (facts.uid !== 1000 || facts.fstype !== "ext4") return;
  if (
    facts.host === "delta-chat-mcp-standard-tests" &&
    facts.source === "/dev/mapper/pve-vm--804--disk--0" &&
    facts.tmpdir === "/home/dev/delta-chat-mcp-automatic-room-wake/.tmp"
  ) return "manual-ct804";
  if (
    facts.host === "delta-chat-mcp-dev" &&
    facts.source === "/dev/mapper/pve-vm--802--disk--0" &&
    facts.tmpdir === "/home/dev/delta-chat-mcp-setup-review/.tmp" &&
    facts.tree?.length === 40 && /^[0-9a-f]{40}$/i.test(facts.tree)
  ) return "hook-ct802";
}
export function assertWitnessChildProfile(): WitnessChildProfile {
  const [source, fstype] = execFileSync("findmnt", [
    "-n",
    "-o",
    "SOURCE,FSTYPE",
    "/",
  ], { encoding: "utf8" }).trim().split(/\s+/);
  const profile = witnessChildProfile({
    host: hostname(),
    uid: getuid?.(),
    source,
    fstype,
    tmpdir: Deno.env.get("TMPDIR"),
    tree: Deno.env.get("M0_TREE"),
  });
  if (!profile) {
    throw new Error(
      "Controlled witness child requires an authorized exact guest profile",
    );
  }
  return profile;
}
