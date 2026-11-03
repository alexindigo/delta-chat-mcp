// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { ModernRelay } from "../../integrations/opencode/modern-relay.ts";
import { RelayFailure } from "../../integrations/opencode/relay.ts";
import { roomMessage, routingFixture } from "../room_routing_support.ts";
import { deadline, poll } from "../support.ts";

Deno.test("SDK resource hint preempts an owned retry sleep while the old receipt keeps failing", async () => {
  const f = await routingFixture();
  let reads = 0, listens = 0, streamAborted = false;
  const observed: number[][] = [];
  const relay = new ModernRelay({
    alias: "relay",
    url: "http://relay.invalid/mcp",
    headers: { Authorization: `Bearer ${f.first.key}` },
    enabled: true,
  }, (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body.method === "subscriptions/listen") {
      listens++;
      init?.signal?.addEventListener("abort", () => {
        streamAborted = true;
      }, { once: true });
    }
    return f.fetcher(url, init);
  });
  try {
    await f.routing.subscribe(f.first.id, "native", 42);
    f.incoming(roomMessage(17));
    await poll(() => f.routing.inbox(f.first.id).deliveries.length === 1);
    relay.startReceiver(async () => {
      const canonical = await relay.inbox();
      observed.push(canonical.deliveries.flatMap((d) => d.message_ids));
      reads++;
      throw new RelayFailure(
        "tool_error",
        false,
        "request_failed",
        "application",
      );
    });
    await poll(
      () => reads >= 3 && relay.health.retryAt - Date.now() > 3000,
      6000,
    );
    const oldDeadline = relay.health.retryAt;
    f.incoming(roomMessage(3));
    await poll(() => observed.some((ids) => ids.includes(3)), 1000);
    assert(Date.now() < oldDeadline);
    assertEquals(listens, 1);
    assertEquals(streamAborted, false);
    assertEquals(relay.connectionCount, 1);
    assertEquals(relay.health.reason, "reconciliation_retry");
    assertEquals(f.routing.inbox(f.first.id).deliveries[0].state, "ready");
    assert(reads >= 4); // callback still failed; the notification only woke sleep
    await deadline(relay.close(), 5000);
    assertEquals(relay.connectionCount, 0);
  } finally {
    await relay.close();
    await f.close();
  }
});
