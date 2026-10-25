// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type Change, ChangeHub } from "../../src/events.ts";
import { publishCoreEvent } from "../../src/core/client.ts";

Deno.test("hub isolates sync and async failures and releases subscriptions", async () => {
  let failures = 0;
  const hub = new ChangeHub(() => {
    failures++;
  });
  const received: Change[] = [];
  const off1 = hub.subscribe(() => {
    throw new Error("fixture");
  });
  const off2 = hub.subscribe(() => Promise.reject(new Error("fixture")));
  const off3 = hub.subscribe((change) => {
    received.push(change);
  });
  hub.emit({ type: "messages", chatId: 42, ids: [9] });
  await Promise.resolve();
  assertEquals(received, [{ type: "messages", chatId: 42, ids: [9] }]);
  assertEquals(failures, 2);
  off1();
  off2();
  off3();
  off3();
  assertEquals(hub.listenerCount, 0);
});
Deno.test("actual core delivery, read, global history and connectivity events wake consumers", () => {
  const hub = new ChangeHub();
  const received: Change[] = [];
  hub.subscribe((change) => {
    received.push(change);
  });
  for (
    const kind of [
      "IncomingMsg",
      "MsgDelivered",
      "MsgFailed",
      "MsgRead",
      "MsgsChanged",
    ] as const
  ) {
    publishCoreEvent(hub, {
      kind,
      chatId: kind === "MsgsChanged" ? 0 : 42,
      msgId: kind === "MsgsChanged" ? 0 : 9,
    });
  }
  publishCoreEvent(hub, { kind: "ConnectivityChanged" });
  assertEquals(received.filter((change) => change.type === "messages"), [
    ...Array.from(
      { length: 4 },
      () => ({ type: "messages" as const, chatId: 42, ids: [9] }),
    ),
    { type: "messages", chatId: 0, ids: [] },
  ]);
  assertEquals(received.at(-1), { type: "connectivity" });
});
