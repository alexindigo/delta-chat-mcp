// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type WitnessChildFacts,
  witnessChildProfile,
} from "../fixtures/owner_witness_profile.ts";

const manual: WitnessChildFacts = {
  host: "delta-chat-mcp-standard-tests",
  uid: 1000,
  source: "/dev/mapper/pve-vm--804--disk--0",
  fstype: "ext4",
  tmpdir: "/home/dev/delta-chat-mcp-automatic-room-wake/.tmp",
  tree: undefined,
};
const hook: WitnessChildFacts = {
  host: "delta-chat-mcp-dev",
  uid: 1000,
  source: "/dev/mapper/pve-vm--802--disk--0",
  fstype: "ext4",
  tmpdir: "/home/dev/delta-chat-mcp-setup-review/.tmp",
  tree: "abcdef0123".repeat(4),
};
Deno.test("controlled witness admits exact manual804 and marked normal-hook802 profiles only", () => {
  assertEquals(witnessChildProfile(manual), "manual-ct804");
  assertEquals(witnessChildProfile(hook), "hook-ct802");
  assertEquals(
    witnessChildProfile({ ...hook, tree: hook.tree!.toUpperCase() }),
    "hook-ct802",
  );
});
Deno.test("controlled witness rejects host, swapped disks, wrong filesystem or UID, temp roots and unmarked hook", () => {
  for (const allowed of [manual, hook]) {
    for (
      const invalid of [
        { ...allowed, host: "laptop" },
        { ...allowed, host: "ark" },
        { ...allowed, host: "agora" },
        { ...allowed, uid: 0 },
        { ...allowed, uid: undefined },
        { ...allowed, source: "/dev/mapper/pve-vm--803--disk--0" },
        {
          ...allowed,
          source: allowed === manual ? hook.source : manual.source,
        },
        { ...allowed, fstype: "tmpfs" },
        { ...allowed, fstype: "btrfs" },
        { ...allowed, tmpdir: undefined },
        { ...allowed, tmpdir: "/other/.tmp" },
        {
          ...allowed,
          tmpdir: allowed === manual ? hook.tmpdir : manual.tmpdir,
        },
      ]
    ) assertEquals(witnessChildProfile(invalid), undefined);
  }
  for (
    const tree of [
      undefined,
      "",
      "0".repeat(39),
      "0".repeat(41),
      "g".repeat(40),
      " " + hook.tree,
      hook.tree + "\n",
    ]
  ) {
    assertEquals(witnessChildProfile({ ...hook, tree }), undefined);
  }
  assertEquals(witnessChildProfile({ ...hook, host: manual.host }), undefined);
  assertEquals(
    witnessChildProfile({ ...manual, host: hook.host, tree: hook.tree }),
    undefined,
  );
});
