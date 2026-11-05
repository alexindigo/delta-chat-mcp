// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, join, resolve } from "@std/path";

export function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Deadline ${ms}ms exceeded`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function poll(
  check: () => boolean | Promise<boolean>,
  ms = 15000,
) {
  const end = Date.now() + ms;
  while (!await check()) {
    requireThat(Date.now() < end, "Condition deadline exceeded");
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** One owner closes every acquired resource, including partial setup failures. */
export async function withOwners<T>(
  work: (own: (close: () => Promise<unknown>) => void) => Promise<T>,
): Promise<T> {
  const owners: (() => Promise<unknown>)[] = [];
  const errors: unknown[] = [];
  let result: T | undefined;
  try {
    result = await work((close) => owners.push(close));
  } catch (error) {
    errors.push(error);
  }
  for (const close of owners.reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      "Artifact workload or owned cleanup failed",
    );
  }
  return result as T;
}
export async function command(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    ms?: number;
    log?: string;
    combined?: boolean;
    trim?: boolean;
    raw?: (stdout: Uint8Array) => Promise<void>;
  } = {},
) {
  const child = new Deno.Command(executable, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already joined */ }
  }, options.ms ?? 120000);
  try {
    const output = await child.output();
    if (options.raw) await options.raw(output.stdout);
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (options.log) await Deno.writeTextFile(options.log, stdout + stderr);
    requireThat(
      output.success,
      `${executable} exited ${output.code}\n${stderr}\n${stdout}`,
    );
    const text = options.combined ? stdout + stderr : stdout;
    return options.trim === false ? text : text.trim();
  } finally {
    clearTimeout(timer);
  }
}
export function argument(name: string) {
  const i = Deno.args.indexOf(name);
  requireThat(i >= 0 && Deno.args[i + 1], `Required argument ${name}`);
  return Deno.args[i + 1];
}
export async function sha256(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0")).join("");
}
export async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(join(root, prefix))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory) result.push(...await files(root, path));
    else if (entry.isFile) result.push(path);
    else throw new Error(`Unexpected non-regular input: ${path}`);
  }
  return result.sort();
}
export async function copyFile(source: string, destination: string) {
  await Deno.mkdir(dirname(destination), { recursive: true });
  await Deno.copyFile(source, destination);
  const mode = (await Deno.stat(source)).mode ?? 0;
  await Deno.chmod(destination, mode & 0o111 ? 0o755 : 0o644);
}
export async function copyTree(source: string, destination: string) {
  for (const file of await files(source)) {
    await copyFile(join(source, file), join(destination, file));
  }
}
export function workspace(path: string) {
  const tmp = Deno.env.get("TMPDIR");
  requireThat(
    tmp?.startsWith("/") && !tmp.startsWith("/tmp"),
    "Disk-backed TMPDIR required",
  );
  requireThat(path.startsWith("/"), "Absolute workspace required");
  return resolve(path);
}
export function record(phase: string, facts: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), phase, ...facts }),
  );
}
