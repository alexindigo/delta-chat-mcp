// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../../src/config.ts";
import { startService } from "../../src/service.ts";
import { createLog } from "../../src/log.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";
import { alive, proveMainShutdown } from "../service_process.ts";
Deno.test("real main health is ready, SIGTERM exits 0 within 15s and owned core disappears", async () => {
  const dir = await fixture("service-lifecycle");
  await proveMainShutdown(dir, false);
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
