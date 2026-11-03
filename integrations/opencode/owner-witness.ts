// SPDX-License-Identifier: LGPL-3.0-only
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { getuid, pid as ownPID, platform } from "node:process";

export interface OwnerWitness {
  v: 1;
  bootID: string;
  pidNS: string;
  timeNS: string;
  userNS: string;
  uid: number;
  pid: number;
  start: string;
}
export type OwnerFate = "dead" | "alive" | "unknown";
export interface OwnerProcess {
  capture(): OwnerWitness | undefined;
  fate(witness: OwnerWitness): OwnerFate;
}
export interface ProcView {
  read(path: string): string;
  readlink(path: string): string;
  stat(path: string): { dev: number | bigint; ino: number | bigint };
}
const proc: ProcView = {
  read: (path) => readFileSync(path, "utf8"),
  readlink: (path) => readlinkSync(path),
  stat: (path) => statSync(path, { bigint: true }),
};
const keys = [
  "v",
  "bootID",
  "pidNS",
  "timeNS",
  "userNS",
  "uid",
  "pid",
  "start",
];
const namespace = (s: unknown) => typeof s === "string" && /^\d+:\d+$/.test(s);

/** Pure data validation; the registry never reads the OS. */
export function parseOwnerWitness(value: unknown): OwnerWitness | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const w = value as Record<string, unknown>;
  if (
    Object.keys(w).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(w, k))
  ) return;
  if (
    w.v !== 1 || typeof w.bootID !== "string" ||
    !/^[a-f0-9]{64}$/.test(w.bootID)
  ) return;
  if (
    !namespace(w.pidNS) || !namespace(w.userNS) ||
    !(w.timeNS === "none" || namespace(w.timeNS))
  ) return;
  if (
    !Number.isSafeInteger(w.uid) || Number(w.uid) < 0 ||
    !Number.isSafeInteger(w.pid) || Number(w.pid) <= 0
  ) return;
  if (typeof w.start !== "string" || !/^\d+$/.test(w.start)) return;
  return {
    v: 1,
    bootID: w.bootID,
    pidNS: String(w.pidNS),
    timeNS: String(w.timeNS),
    userNS: String(w.userNS),
    uid: Number(w.uid),
    pid: Number(w.pid),
    start: w.start,
  };
}
export function sameOwnerScope(a: OwnerWitness, b: OwnerWitness): boolean {
  return ["bootID", "pidNS", "timeNS", "userNS", "uid"].every((k) =>
    a[k as keyof OwnerWitness] === b[k as keyof OwnerWitness]
  );
}
function code(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}
function startToken(stat: string, pid: number): string | undefined {
  const first = /^([1-9]\d*) \(/.exec(stat), end = stat.lastIndexOf(")");
  if (
    !first || Number(first[1]) !== pid || end < first[0].length ||
    stat[end + 1] !== " "
  ) return;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (
    !/^[A-Za-z]$/.test(fields[0]) || fields.length < 20 ||
    !/^\d+$/.test(fields[19])
  ) return;
  return fields[19];
}
function ns(view: ProcView, name: string): string {
  try {
    const { dev, ino } = view.stat(`/proc/self/ns/${name}`);
    for (const n of [dev, ino]) {
      if (
        typeof n === "number"
          ? !Number.isSafeInteger(n) || n < 0
          : typeof n !== "bigint" || n < 0n
      ) throw new Error("Invalid namespace identity");
    }
    if (BigInt(ino) === 0n) throw new Error("Invalid namespace inode");
    return `${dev}:${ino}`;
  } catch (error) {
    if (name === "time" && code(error) === "ENOENT") return "none";
    throw error;
  }
}
function visible(view: ProcView): boolean {
  const mounts = view.read("/proc/self/mountinfo").trim().split("\n").map((
    line,
  ) => line.split(" "));
  const atProc = mounts.filter((f) => f[4] === "/proc");
  if (atProc.length !== 1) return false;
  const f = atProc[0], sep = f.indexOf("-");
  if (sep < 6 || f[3] !== "/" || f[sep + 1] !== "proc" || !f[sep + 3]) {
    return false;
  }
  const options = [...f[5].split(","), ...f[sep + 3].split(",")];
  return options.every((o) =>
    !o.startsWith("hidepid") || o === "hidepid=0" || o === "hidepid=off"
  );
}

/** Only the currently validated Linux proc view can register a process owner. */
export function captureOwnerWitness(
  view: ProcView = proc,
  pid = ownPID,
  uid?: number,
): OwnerWitness | undefined {
  try {
    uid ??= typeof getuid === "function" ? getuid() : -1;
    if (
      platform !== "linux" || typeof getuid !== "function" ||
      !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) ||
      uid < 0
    ) return;
    if (view.readlink("/proc/self") !== String(pid)) return;
    const status = view.read("/proc/self/status");
    const lines = status.split("\n").filter((line) =>
      line.startsWith("NSpid:")
    );
    if (
      lines.length !== 1 || lines[0].slice(6).trim() !== String(pid) ||
      !visible(view)
    ) return;
    const boot = view.read("/proc/sys/kernel/random/boot_id").trim();
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(boot)) return;
    const start = startToken(view.read("/proc/self/stat"), pid);
    if (
      start === undefined ||
      startToken(view.read(`/proc/${pid}/stat`), pid) !== start
    ) return;
    return parseOwnerWitness({
      v: 1,
      bootID: createHash("sha256").update(boot.toLowerCase()).digest("hex"),
      pidNS: ns(view, "pid"),
      timeNS: ns(view, "time"),
      userNS: ns(view, "user"),
      uid,
      pid,
      start,
    });
  } catch {
    return;
  }
}

/** Only exact PID absence/reuse in a matching, freshly validated scope is death. */
export function probeOwner(
  value: OwnerWitness,
  view: ProcView = proc,
): OwnerFate {
  try {
    const witness = parseOwnerWitness(value), self = captureOwnerWitness(view);
    if (!witness || !self || !sameOwnerScope(witness, self)) return "unknown";
    if (witness.pid === self.pid && witness.start === self.start) {
      return "alive";
    }
    let start: string | undefined;
    try {
      start = startToken(view.read(`/proc/${witness.pid}/stat`), witness.pid);
    } catch (error) {
      return code(error) === "ENOENT" ? "dead" : "unknown";
    }
    if (start === undefined) return "unknown";
    return start === witness.start ? "alive" : "dead";
  } catch {
    return "unknown";
  }
}

export const localOwnerProcess: OwnerProcess = {
  capture: captureOwnerWitness,
  fate: probeOwner,
};
