// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../../src/config.ts";
import { startService } from "../../src/service.ts";
import { createLog } from "../../src/log.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";
import { proveMainShutdown } from "../service_process.ts";

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
function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
Deno.test("real main health is ready, SIGTERM exits 0 within 15s and owned core disappears", async () => {
  const dir = await fixture("service-lifecycle");
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
  let pid: number | undefined;
  try {
    const port = await deadline(ready.promise, 20000);
    const response = await fetch(`http://${lanAddress()}:${port}/_/health`);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      ok: true,
      core: "ready",
      configured: false,
    });
    const children = await coreChildren(child.pid);
    assertEquals(children.length, 1);
    pid = children[0];
    assert(alive(pid));
    const start = Date.now();
    child.kill("SIGTERM");
    assertEquals((await deadline(status, 15000)).code, 0);
    assert(Date.now() - start < 15000);
    await poll(() => !alive(pid!));
    assertEquals(await coreChildren(child.pid), []);
    await Promise.all([stdout, stderr]);
    assert(output.join("").includes('"event":"service_stopped"'));
  } finally {
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
});
Deno.test("real main cancels an admitted incomplete request and pre-request connection within 15s", async () => {
  for (const held of ["request-body", "headers"] as const) {
    const outcome = await proveMainShutdown(
      await fixture("service-busy"),
      false,
      held,
    );
    console.log({ held, ...outcome });
  }
});
Deno.test("listener collision fails before creating durable state; ready health observes core recovery", async () => {
  const dir = await fixture("service");
  const listener = Deno.listen({ hostname: "0.0.0.0", port: 0 });
  const cfg = loadConfig({
    env: {
      DCMCP_DATA_DIR: `${dir}/new-state`,
      DCMCP_LISTEN_PORT: String(listener.addr.port),
    },
  });
  try {
    await assertRejects(() => startService(cfg), Deno.errors.AddrInUse);
    await assertRejects(() => Deno.stat(cfg.data.dir), Deno.errors.NotFound);
  } finally {
    listener.close();
  }
  cfg.listen.port = 0;
  const service = await startService(cfg, {
    log: createLog("error", [], () => {}),
  });
  const pid = service.corePid()!;
  try {
    assert(!("auth" in service.app.cfg));
    const enrollment = await fetch(
      `http://${lanAddress()}:${service.addr.port}/api/auth/enroll`,
      {
        method: "POST",
        headers: {
          origin: `http://${lanAddress()}:${service.addr.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "fixture" }),
      },
    );
    assertEquals(enrollment.status, 200);
    const qr = await enrollment.json();
    assert(qr.uri.startsWith("otpauth://totp/"));
    assert(qr.qr.includes("<svg"));
    assertEquals((await service.app.account.status()).configured, false);
    Deno.kill(pid, "SIGKILL");
    await poll(() => service.app.health().core === "restarting");
    const response = await fetch(
      `http://${lanAddress()}:${service.addr.port}/_/health`,
    );
    assertEquals((await response.json()).core, "restarting");
    await poll(() => service.app.health().core === "ready", 10000);
    assert(service.corePid() !== pid);
    const mcp = await fetch(`http://${lanAddress()}:${service.addr.port}/mcp`);
    assertEquals(mcp.status, 503);
    await mcp.body?.cancel();
  } finally {
    await deadline(service.close());
  }
  assertEquals(alive(pid), false);
});
