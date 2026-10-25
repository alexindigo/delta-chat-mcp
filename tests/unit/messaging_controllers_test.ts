// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Messaging } from "../../web/src/messaging.ts";
import type {
  Account,
  Message,
  MessagingApi,
} from "../../web/src/messaging-types.ts";
import { ApiError } from "../../web/src/api.ts";
import { route } from "../../web/src/location.ts";
import { poll } from "../support.ts";

const account: Account = {
  configured: true,
  accountId: 1,
  address: "a@relay",
  displayName: "A",
  connectivity: 4000,
  core: "ready",
};
const message = (chatId: number, id = 5): Message => ({
  id,
  chatId,
  fromContactId: 42,
  fromSelf: false,
  text: "peer",
  timestamp: 1,
  state: "fresh",
  encrypted: true,
  hasAttachment: false,
});
function fixture() {
  let change = () => {}, state = (_value: boolean) => {};
  let sends: (
    id: number,
    text: string,
  ) => Promise<{ messageId: number; chatId: number; state: string }> = (id) =>
    Promise.resolve({ messageId: 7, chatId: id, state: "pending" });
  const seen: unknown[] = [];
  const api: MessagingApi = {
    account: () => Promise.resolve(account),
    createIdentity: () => Promise.resolve({}),
    invite: () => Promise.resolve({ link: "invite", svg: "<svg/>" }),
    contacts: () => Promise.resolve({ contacts: [] }),
    join: () => Promise.resolve({ chatId: 3 }),
    openChat: () => Promise.resolve({ chatId: 3 }),
    request: () => Promise.resolve({}),
    chats: () => Promise.resolve({ chats: [] }),
    chat: (id) =>
      Promise.resolve({
        id,
        name: `Chat ${id}`,
        type: 100,
        isEncrypted: true,
        isContactRequest: false,
        freshMessageCount: 1,
        contactIds: [42],
        canSend: true,
      }),
    messages: (id) => Promise.resolve({ messages: [message(id)] }),
    send: (id, text) => sends(id, text),
    seen: (id, ids) => {
      seen.push([id, ids]);
      return Promise.resolve({});
    },
    removeMessages: () => Promise.resolve({}),
  };
  const app = new Messaging(
    api,
    {
      start(fn, fnState) {
        change = fn;
        state = fnState;
      },
      close() {},
    },
    () => {},
    () => {},
    () => {},
    () => Promise.resolve(),
  );
  return {
    app,
    api,
    seen,
    change: () => change(),
    connected: (value: boolean) => state(value),
    send(fn: typeof sends) {
      sends = fn;
    },
  };
}
Deno.test("controller preserves per-chat draft revisions through late sends, failures, hints and logout", async () => {
  const f = fixture();
  f.app.start();
  f.connected(true);
  f.app.select(3);
  await poll(() => Promise.resolve(f.app.state.messages.length === 1));
  assertEquals(f.seen, []);
  f.app.presented([5, 999]);
  await Promise.resolve();
  assertEquals(f.seen, [[3, [5]]]);
  f.app.draft("first");
  const pending = Promise.withResolvers<
    { messageId: number; chatId: number; state: string }
  >();
  f.send(() => pending.promise);
  const sending = f.app.send();
  f.app.draft("new text");
  f.app.select(4);
  f.app.draft("other chat");
  pending.resolve({ messageId: 7, chatId: 3, state: "delivered" });
  await sending;
  assertEquals(f.app.state.draft, "other chat");
  f.app.select(3);
  assertEquals(f.app.state.draft, "new text");
  f.send(() => Promise.reject(new ApiError(503, "Retry send")));
  await f.app.send();
  assertEquals(f.app.state.draft, "new text");
  assertEquals(f.app.state.sendError, "Retry send");
  f.connected(false);
  f.change();
  await new Promise((r) => setTimeout(r, 120));
  assertEquals(f.app.state.draft, "new text");
  assert(f.app.state.connection.includes("interrupted"));
  const late = Promise.withResolvers<
    { messageId: number; chatId: number; state: string }
  >();
  f.send(() => late.promise);
  const last = f.app.send();
  f.app.stop(true);
  late.resolve({ messageId: 8, chatId: 3, state: "pending" });
  await last;
  assertEquals(f.app.state.draft, "");
  assertEquals(f.app.state.account, null);
  assertEquals(f.app.dirty, false);
});
Deno.test("offscreen history and failed identity never overwrite current selection or input", async () => {
  const f = fixture();
  const slow = Promise.withResolvers<{ messages: Message[] }>();
  f.api.messages = (id) =>
    id === 3 ? slow.promise : Promise.resolve({ messages: [message(id, 9)] });
  f.app.start();
  f.app.select(3);
  f.app.select(4);
  await poll(() => Promise.resolve(f.app.state.messages[0]?.id === 9));
  slow.resolve({ messages: [message(3)] });
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(f.app.state.chatId, 4);
  assertEquals(f.app.state.messages[0].chatId, 4);
  f.app.identityField("relay", "DCACCOUNT:relay");
  f.app.identityField("displayName", "Name");
  f.api.createIdentity = () => Promise.reject(new ApiError(400, "Retry"));
  await f.app.create();
  assertEquals(f.app.state.relay, "DCACCOUNT:relay");
  assertEquals(f.app.state.displayName, "Name");
  assertEquals(f.app.state.identityError, "Retry");
  f.app.stop(true);
});
Deno.test("location parser maps path/query deep links and invalid links without invented chat ids", () => {
  for (const path of ["/chats/42", "/chats?chat=42"]) {
    assertEquals(route(new URL(`http://relay${path}`)).chatId, 42);
  }
  assertEquals(route(new URL("http://relay/chats/0")).chatId, null);
  assert(route(new URL("http://relay/chats/0")).error);
  assertEquals(route(new URL("http://relay/contacts")).screen, "contacts");
});
