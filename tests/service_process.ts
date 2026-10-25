// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { deadline, lanAddress, poll } from "./support.ts";
import { HttpConnection } from "./http_connection.ts";
async function coreChildren(pid: number): Promise<number[]> {
  const result = await new Deno.Command("pgrep", {
    args: ["-P", String(pid), "-f", "deltachat-rpc-server"],
  }).output();
  if (result.code === 1) return [];
  assertEquals(result.code, 0);
  return new TextDecoder().decode(result.stdout).trim().split(/\s+/).map(
    Number,
  );
}
export function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
/** Real executable, health consumer, joined child exit, and optionally a busy peer. */
export async function proveMainShutdown(
  dir: string,
  configured: boolean,
  held: "request-body" | "headers" | null = null,
) {
  const ready = Promise.withResolvers<number>();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
    ],
    env: { DCMCP_LISTEN_PORT: "0", DCMCP_DATA_DIR: dir },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let exited = false;
  const status = child.status.then((result) => {
    exited = true;
    return result;
  });
  const output: string[] = [];
  const stdout = (async () => {
    let pending = "";
    for await (
      const chunk of child.stdout.pipeThrough(new TextDecoderStream())
    ) {
      output.push(chunk);
      pending += chunk;
      while (pending.includes("\n")) {
        const split = pending.indexOf("\n"), line = pending.slice(0, split);
        pending = pending.slice(split + 1);
        if (!line.startsWith("{")) continue;
        const record = JSON.parse(line);
        if (record.event === "service_ready") ready.resolve(record.fields.port);
      }
    }
    ready.reject(new Error("Main exited before readiness"));
  })();
  const stderr = (async () => {
    for await (
      const chunk of child.stderr.pipeThrough(new TextDecoderStream())
    ) output.push(chunk);
  })();
  let pid: number | undefined, peer: HttpConnection | undefined;
  try {
    const port = await deadline(ready.promise, 20000);
    const response = await fetch(`http://${lanAddress()}:${port}/_/health`);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      ok: true,
      core: "ready",
      configured,
    });
    const children = await coreChildren(child.pid);
    assertEquals(children.length, 1);
    pid = children[0];
    assert(alive(pid));
    if (held) {
      peer = new HttpConnection(
        await Deno.connect({ hostname: lanAddress(), port }),
      );
      if (held === "request-body") {
        await peer.write(
          `GET /_/health HTTP/1.1\r\nHost: ${lanAddress()}:${port}\r\nContent-Length: 53\r\nConnection: close\r\n\r\n{`,
        );
        // A real response witnesses request admission, not merely an open port.
        await poll(() => peer!.wire.includes('"core":"ready"'));
      } else {
        await peer.write(
          `GET /_/health HTTP/1.1\r\nHost: ${lanAddress()}:${port}\r\n`,
        );
      }
      assertEquals(peer.ended, false);
    }
    const start = Date.now();
    child.kill("SIGTERM");
    assertEquals((await deadline(status, 15000)).code, 0);
    const elapsedMs = Date.now() - start;
    assert(elapsedMs < 15000);
    if (peer) {
      await deadline(peer.finished, 1000);
      assert(peer.ended);
    }
    await poll(() => !alive(pid!));
    assertEquals(await coreChildren(child.pid), []);
    await Promise.all([stdout, stderr]);
    assert(output.join("").includes('"event":"service_stopped"'));
    return { elapsedMs, coreAbsent: true, exitCode: 0 };
  } finally {
    // Failed red tests release only their own peer, then join owned processes.
    await peer?.close();
    if (!exited) {
      child.kill("SIGTERM");
      try {
        await deadline(status, 15000);
      } catch {
        child.kill("SIGKILL");
        await status;
      }
    }
    await Promise.all([stdout, stderr]);
    if (pid) assertEquals(alive(pid), false);
  }
}
