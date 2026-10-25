// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { CoreMessage } from "../../src/core/client.ts";
import {
  ChatsService,
  UnknownMessageAnchor,
} from "../../src/messaging/chats.ts";
import { SendService } from "../../src/messaging/send.ts";
import { DeleteService } from "../../src/messaging/delete.ts";
import { AccountService } from "../../src/messaging/account.ts";
import { ChangeHub } from "../../src/events.ts";
import { FakeCore } from "./fake_core.ts";
import { deadline } from "../support.ts";

function raw(id: number, fromId = 42): CoreMessage {
  // Unused upstream presentation fields are intentionally absent in this fake.
  return {
    id,
    chatId: 99,
    fromId,
    text: `fixture-${id}`,
    timestamp: id,
    state: fromId === 1 ? 20 : 10,
    file: null,
    fileName: null,
    showPadlock: true,
  } as CoreMessage;
}
function setup(initial = [900, 100, 700]) {
  const hub = new ChangeHub();
  const ids = [...initial];
  const messages = new Map(ids.map((id) => [id, raw(id)]));
  const seen: number[] = [];
  let afterSnapshot: (() => void) | undefined;
  const core = new FakeCore({
    getAllAccountIds: () => Promise.resolve([7]),
    isConfigured: () => Promise.resolve(true),
    getMessageIds: () => {
      const snapshot = [...ids];
      afterSnapshot?.();
      afterSnapshot = undefined;
      return Promise.resolve(snapshot);
    },
    getMessages: (_id, selected) =>
      Promise.resolve(
        Object.fromEntries(
          selected.map((id) => [id, { kind: "message", ...messages.get(id)! }]),
        ),
      ),
    getMessage: (_id, id) => Promise.resolve(messages.get(id)!),
    getExistingMsgIds: (_id, selected) =>
      Promise.resolve(selected.filter((id) => messages.has(id))),
    markseenMsgs: (_id, selected) => {
      seen.push(...selected);
      return Promise.resolve(null);
    },
    createChatByContactId: () => Promise.resolve(99),
    miscSendTextMessage: (_id, _chat, text) => {
      ids.push(500);
      messages.set(500, { ...raw(500, 1), text });
      return Promise.resolve(500);
    },
    deleteMessages: (_id, selected) => {
      for (const id of selected) {
        messages.delete(id);
        const index = ids.indexOf(id);
        if (index !== -1) ids.splice(index, 1);
      }
      return Promise.resolve(null);
    },
  });
  const account = new AccountService(core, hub);
  return {
    core,
    hub,
    seen,
    ids,
    messages,
    chats: new ChatsService(core, account, hub, 600),
    send: new SendService(core, account),
    remove: new DeleteService(core, account),
    onSnapshot(fn: () => void) {
      afterSnapshot = fn;
    },
    add(id: number) {
      ids.push(id);
      messages.set(id, raw(id));
      hub.emit({ type: "messages", chatId: 99, ids: [id] });
    },
  };
}
Deno.test("history slices actual core order, not numeric IDs, with explicit caller anchors", async () => {
  const { chats } = setup();
  assertEquals(
    (await chats.messages(99, { afterId: 900 })).map((message) => message.id),
    [100, 700],
  );
  assertEquals(
    (await chats.messages(99, { beforeId: 700, limit: 1 })).map((message) =>
      message.id
    ),
    [100],
  );
  assertEquals(
    (await chats.messages(99, { limit: 2 })).map((message) => message.id),
    [100, 700],
  );
  assertEquals(
    (await chats.messages(99, { afterId: 900, beforeId: 700 })).map((message) =>
      message.text
    ),
    ["fixture-100"],
  );
  await assertRejects(
    () => chats.messages(99, { afterId: 5000 }),
    UnknownMessageAnchor,
  );
});
Deno.test("wait subscribes before reading and rechecks an event concurrent with its empty snapshot", async () => {
  const app = setup([900]);
  app.onSnapshot(() => {
    assertEquals(app.hub.listenerCount, 1);
    app.add(100);
  });
  const result = await deadline(app.chats.waitForMessage(99, 900, 1000));
  assertEquals(result.messages.map((message) => message.text), ["fixture-100"]);
  assertEquals(result.timedOut, false);
  assertEquals(app.hub.listenerCount, 0);
  // Already-arrived data resolves without needing a subsequent event.
  assertEquals(
    (await app.chats.waitForMessage(99, 900, 1000)).messages[0].id,
    100,
  );
});
Deno.test("wait remains subscribed through recovery, and timeout/abort release subscriptions", async () => {
  const app = setup([900]);
  app.core.available = false;
  const wait = app.chats.waitForMessage(99, 900, 1000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(app.hub.listenerCount, 1);
  app.core.available = true;
  app.ids.push(100);
  app.messages.set(100, raw(100));
  app.hub.emit({ type: "connectivity" });
  assertEquals((await deadline(wait)).messages[0].text, "fixture-100");
  assertEquals(app.hub.listenerCount, 0);
  const controller = new AbortController();
  const aborted = app.chats.waitForMessage(99, 100, 1000, controller.signal);
  controller.abort();
  await assertRejects(() => aborted, DOMException, "aborted");
  assertEquals(app.hub.listenerCount, 0);
  const start = Date.now();
  assertEquals(await app.chats.waitForMessage(99, 100, 30), {
    timedOut: true,
    messages: [],
  });
  assert(Date.now() - start >= 20);
  assertEquals(app.hub.listenerCount, 0);
});
Deno.test("send preserves exact text, read uses markseen and deletion is local-only", async () => {
  const app = setup();
  assertEquals(await app.send.sendTextToContact(42, " exact fixture \n"), {
    messageId: 500,
    chatId: 99,
    state: "pending",
  });
  const sent = (await app.chats.messages(99, { afterId: 700 }))[0];
  assertEquals(sent.text, " exact fixture \n");
  assertEquals(sent.fromSelf, true);
  assertEquals(sent.encrypted, true);
  assertEquals(await app.send.status([500]), [{
    messageId: 500,
    state: "pending",
  }]);
  await app.chats.markSeen([100, 100]);
  assertEquals(app.seen, [100]);
  await app.remove.deleteMessages([100]);
  assertEquals((await app.chats.messages(99)).map((message) => message.id), [
    900,
    700,
    500,
  ]);
  assertEquals(
    app.core.calls.filter((call) => call.method.startsWith("delete")),
    [{ method: "deleteMessages", args: [7, [100]] }],
  );
});
Deno.test("history distinguishes concurrent deletion from failure loading an existing message", async () => {
  const app = setup([900]);
  app.core.handlers.getMessages = () =>
    Promise.resolve({ 900: { kind: "loadingError", error: "fixture" } });
  await assertRejects(
    () => app.chats.messages(99),
    Error,
    "Unable to load existing message",
  );
  app.messages.delete(900);
  assertEquals(await app.chats.messages(99), []);
});
Deno.test("global history invalidation wakes wait and attachments expose names without blob paths", async () => {
  const app = setup([900]);
  const waiting = app.chats.waitForMessage(99, 900, 1000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.ids.push(100);
  app.messages.set(100, {
    ...raw(100),
    file: "/fixture/blob",
    fileName: "fixture.txt",
  });
  app.hub.emit({ type: "messages", chatId: 0, ids: [] });
  const result = await deadline(waiting);
  assertEquals(result.messages[0].attachmentName, "fixture.txt");
  assertEquals(result.messages[0].hasAttachment, true);
  assert(!JSON.stringify(result).includes("/fixture/blob"));
  assertEquals(app.hub.listenerCount, 0);
});
Deno.test("service-owned wait lifetime aborts outstanding subscriptions on shutdown", async () => {
  const app = setup([900]);
  const waiting = app.chats.waitForMessage(99, 900, 1000);
  app.chats.close();
  await assertRejects(() => waiting, DOMException, "aborted");
  assertEquals(app.hub.listenerCount, 0);
});
