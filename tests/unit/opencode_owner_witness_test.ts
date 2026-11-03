// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { getuid, pid } from "node:process";
import { assertWitnessChildProfile } from "../fixtures/owner_witness_profile.ts";
import {
  captureOwnerWitness,
  parseOwnerWitness,
  probeOwner,
  type ProcView,
} from "../../integrations/opencode/owner-witness.ts";
import { deadline } from "../support.ts";

const stat = (p: number, start = "123", state = "S") =>
  `${p} (worker ) (name)) ${state} ${
    Array(18).fill("0").join(" ")
  } ${start} 0 0`;
function fixture() {
  const files = new Map([
    ["/proc/self/status", `Name:\tfixture\nNSpid:\t${pid}\n`],
    ["/proc/self/mountinfo", "1 0 0:1 / /proc rw - proc proc rw,subset=pid"],
    [
      "/proc/sys/kernel/random/boot_id",
      "12345678-1234-1234-1234-123456789abc\n",
    ],
    ["/proc/self/stat", stat(pid)],
    [`/proc/${pid}/stat`, stat(pid)],
    ["/proc/123456/stat", stat(123456, "456")],
  ]);
  const failures = new Map<string, string>();
  const view: ProcView = {
    read(p) {
      if (failures.has(p)) {
        throw Object.assign(new Error("fixture"), { code: failures.get(p) });
      }
      if (!files.has(p)) {
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      }
      return files.get(p)!;
    },
    readlink: () => String(pid),
    stat(p) {
      if (failures.has(p)) {
        throw Object.assign(new Error("fixture"), { code: failures.get(p) });
      }
      return {
        dev: 4n,
        ino: p.endsWith("pid") ? 1n : p.endsWith("time") ? 2n : 3n,
      };
    },
  };
  const own = captureOwnerWitness(view)!;
  assert(own);
  return {
    files,
    failures,
    view,
    own,
    other: { ...own, pid: 123456, start: "456" },
  };
}
Deno.test("owner witness validates scope, hashes boot ID, parses comm parentheses, self and live/zombie owners", () => {
  const f = fixture();
  assertEquals(f.own.start, "123");
  assertEquals(f.own.bootID.length, 64);
  assert(!f.own.bootID.includes("-"));
  assertEquals(probeOwner(f.own, f.view), "alive");
  for (const state of ["S", "Z", "X"]) {
    f.files.set("/proc/123456/stat", stat(123456, "456", state));
    assertEquals(probeOwner(f.other, f.view), "alive");
  }
  f.files.set("/proc/123456/stat", stat(123456, "789"));
  assertEquals(probeOwner(f.other, f.view), "dead");
  f.files.delete("/proc/123456/stat");
  assertEquals(probeOwner(f.other, f.view), "dead");
});
Deno.test("owner witness fails closed on every scope mismatch, malformed witness/stat and non-ENOENT errors", () => {
  const f = fixture();
  for (
    const [key, value] of Object.entries({
      bootID: "a".repeat(64),
      pidNS: "9:1",
      timeNS: "none",
      userNS: "9:3",
      uid: Number(getuid!()) + 1,
    })
  ) assertEquals(probeOwner({ ...f.other, [key]: value }, f.view), "unknown");
  for (
    const value of [{ ...f.other, v: 2 }, { ...f.other, start: "bad" }, {
      ...f.other,
      extra: true,
    }, { ...f.other, bootID: "raw-uuid" }]
  ) assertEquals(parseOwnerWitness(value), undefined);
  for (const error of ["EACCES", "ESRCH", "EIO"]) {
    f.failures.set("/proc/123456/stat", error);
    assertEquals(probeOwner(f.other, f.view), "unknown");
  }
  f.failures.clear();
  for (const value of ["broken", stat(123455), stat(123456, "NaN")]) {
    f.files.set("/proc/123456/stat", value);
    assertEquals(probeOwner(f.other, f.view), "unknown");
  }
});
Deno.test("owner witness rejects hidden/ambiguous proc views and self/PID/start mismatch; only absent time namespace is supported", () => {
  const f = fixture(), mount = f.files.get("/proc/self/mountinfo")!;
  for (
    const options of ["hidepid=1", "hidepid=2", "hidepid=invisible", "hidepid"]
  ) {
    f.files.set("/proc/self/mountinfo", mount + "," + options);
    assertEquals(captureOwnerWitness(f.view), undefined);
  }
  for (const options of ["hidepid=0", "hidepid=off"]) {
    f.files.set("/proc/self/mountinfo", mount + "," + options);
    assert(captureOwnerWitness(f.view));
  }
  f.files.set("/proc/self/mountinfo", mount + "\n" + mount);
  assertEquals(captureOwnerWitness(f.view), undefined);
  f.files.set("/proc/self/mountinfo", mount);
  for (
    const value of ["Name: missing", `NSpid:\t1 ${pid}`, `NSpid:\t${pid + 1}`]
  ) {
    f.files.set("/proc/self/status", value);
    assertEquals(captureOwnerWitness(f.view), undefined);
  }
  f.files.set("/proc/self/status", `NSpid:\t${pid}`);
  assertEquals(
    captureOwnerWitness({ ...f.view, readlink: () => "1" }),
    undefined,
  );
  f.files.set(`/proc/${pid}/stat`, stat(pid, "999"));
  assertEquals(captureOwnerWitness(f.view), undefined);
  f.files.set(`/proc/${pid}/stat`, stat(pid));
  f.failures.set("/proc/self/ns/time", "EACCES");
  assertEquals(captureOwnerWitness(f.view), undefined);
  f.failures.set("/proc/self/ns/time", "ENOENT");
  assertEquals(captureOwnerWitness(f.view)?.timeNS, "none");
  f.failures.set("/proc/self/ns/pid", "ENOENT");
  assertEquals(captureOwnerWitness(f.view), undefined);
});
Deno.test("authorized real controlled child witness is alive while waiting and dead after awaited reaped exit", async () => {
  const profile = assertWitnessChildProfile();
  const result = await deadline(new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      new URL("../fixtures/owner_witness_child.ts", import.meta.url).pathname,
      "driver",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output());
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  const proof = JSON.parse(new TextDecoder().decode(result.stdout));
  assertEquals(proof.profile, profile);
  assertEquals([proof.self, proof.waiting, proof.reaped], [
    "alive",
    "alive",
    "dead",
  ]);
  assert(parseOwnerWitness(proof.witness));
});
