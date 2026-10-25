// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { EventStreams } from "../../src/http/event-streams.ts";
import { ChangeHub } from "../../src/events.ts";
import { poll } from "../support.ts";

Deno.test("SSE bounds and coalesces hints; cancellation, logout, expiry and shutdown release listeners", async () => {
  const hub = new ChangeHub();
  let valid = true;
  const streams = new EventStreams(hub, {
    authenticated: () => Promise.resolve(valid),
  }, 20);
  const request = () =>
    new Request("http://relay/api/events", {
      headers: { cookie: "session=fixture" },
    });
  const reader = streams.response(request()).body!.getReader();
  const decode = async () =>
    new TextDecoder().decode((await reader.read()).value);
  assert((await decode()).includes(streams.bootId));
  // One frame in the native stream, at most32 pending keys, then one resync.
  for (let chatId = 1; chatId < 200; chatId++) {
    hub.emit({ type: "messages", chatId, ids: [chatId] });
  }
  const frame = await decode();
  assert(frame.includes('"hints"'));
  assert(!frame.includes('"ids"'));
  assert((await decode()).includes("event: resync"));
  await reader.cancel();
  assertEquals(hub.listenerCount, 0);
  const second = streams.response(request()).body!.getReader();
  await second.read();
  streams.logout(request());
  assertEquals((await second.read()).done, true);
  assertEquals(streams.size, 0);
  const third = streams.response(request()).body!.getReader();
  await third.read();
  valid = false;
  await poll(() => Promise.resolve(streams.size === 0));
  assertEquals((await third.read()).done, true);
  valid = true;
  const abort = new AbortController();
  const fourth = streams.response(
    new Request("http://relay/api/events", { signal: abort.signal }),
  ).body!.getReader();
  await fourth.read();
  abort.abort();
  assertEquals((await fourth.read()).done, true);
  const fifth = streams.response(request()).body!.getReader();
  await fifth.read();
  streams.close();
  assertEquals((await fifth.read()).done, true);
  assertEquals(hub.listenerCount, 0);
  assertEquals(streams.size, 0);
});
