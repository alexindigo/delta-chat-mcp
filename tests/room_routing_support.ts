// SPDX-License-Identifier: LGPL-3.0-only
import { ChangeHub } from "../src/events.ts";
import { UnknownMessageAnchor } from "../src/messaging/chats.ts";
import type { MessageRange } from "../src/messaging/chats.ts";
import type { Message } from "../src/messaging/message.ts";
import { RoomRouting } from "../src/messaging/room-routing.ts";
import { RoomRoutingStore } from "../src/messaging/room-routing-store.ts";
import { McpTransport } from "../src/mcp/transport.ts";
import type { ServiceBag } from "../src/service.ts";
import { authFixture } from "./auth_support.ts";

export function roomMessage(id: number, patch: Partial<Message> = {}): Message {
  return {
    id,
    chatId: 42,
    fromContactId: 20,
    fromSelf: false,
    fromName: "Peer",
    fromAddress: "peer@example.invalid",
    text: `body-${id}`,
    textComplete: true,
    isInfo: false,
    isBot: false,
    isForwarded: false,
    timestamp: id,
    state: "fresh",
    hasAttachment: false,
    encrypted: true,
    ...patch,
  };
}
/** Real routing/store/HTTP adapters, injected canonical core view and sends. */
export async function routingFixture(now?: () => number) {
  const access = await authFixture();
  await access.auth.setup({
    type: "password",
    username: "test",
    password: "fixture-password",
  });
  const first = await access.apiKeys.create("first"),
    second = await access.apiKeys.create("second");
  const events = new ChangeHub(), history = [roomMessage(900)];
  const sent: { chat: number; text: string }[] = [], seen: number[] = [];
  let failSend = false;
  const messages = (
    _chat: number,
    range: MessageRange = {},
    fromStart = false,
  ) => {
    const a = range.afterId === undefined
      ? -1
      : history.findIndex((m) => m.id === range.afterId);
    const b = range.beforeId === undefined
      ? history.length
      : history.findIndex((m) => m.id === range.beforeId);
    if ((range.afterId !== undefined && a === -1) || b === -1) {
      throw new UnknownMessageAnchor();
    }
    const rows = history.slice(a + 1, b), limit = range.limit ?? 50;
    return Promise.resolve(
      range.afterId === undefined && !fromStart
        ? rows.slice(-limit)
        : rows.slice(0, limit),
    );
  };
  const chats = {
    get: (id: number) =>
      Promise.resolve({
        id,
        name: "Test room",
        type: "Group" as const,
        isEncrypted: true,
        isContactRequest: false,
        contactIds: [1, 20],
        freshMessageCount: 0,
        canSend: true,
        isUnpromoted: false,
        selfInGroup: true,
      }),
    messages,
    routingMessages: (chat: number, afterId?: number) =>
      messages(chat, { afterId, limit: 100 }, true),
    markSeen: (ids: readonly number[]) => {
      seen.push(...ids);
      return Promise.resolve();
    },
    readMessages: async (chat: number, range: MessageRange) => {
      const rows = await messages(chat, range);
      seen.push(...rows.filter((m) => !m.fromSelf).map((m) => m.id));
      return rows;
    },
    list: () => Promise.resolve([{ id: 42, name: "Test room" }]),
  };
  const send = {
    sendText: (chat: number, text: string) => {
      sent.push({ chat, text });
      if (failSend) return Promise.reject(new Error("Unknown core result"));
      return Promise.resolve({
        messageId: 10000 + sent.length,
        chatId: chat,
        state: "delivered" as const,
      });
    },
  };
  const routing = new RoomRouting(new RoomRoutingStore(access.db), {
    chats,
    send,
    events,
    authorized: (owner) => access.apiKeys.has(owner),
    now,
  });
  const services = {
    ...access,
    apiKeys: access.apiKeys,
    events,
    routing,
    chats,
    send,
    cfg: access.cfg,
    account: {
      status: () => Promise.resolve({ address: "relay@example.invalid" }),
    },
    contacts: { list: () => Promise.resolve([]) },
  } as unknown as ServiceBag;
  const transport = new McpTransport(services);
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const owner = await access.apiKeys.authenticate(request);
    if (!owner) {
      return Response.json({ error: "Bearer key required" }, { status: 401 });
    }
    return await transport.handleRequest(request, owner);
  };
  return {
    access,
    first,
    second,
    routing,
    history,
    events,
    sent,
    seen,
    fetcher,
    transport,
    chats,
    send,
    failSend() {
      failSend = true;
    },
    incoming(...rows: Message[]) {
      history.push(...rows);
      events.emit({ type: "messages", chatId: 42, ids: rows.map((m) => m.id) });
    },
    async close() {
      await transport.close();
      await routing.close();
      access.close();
    },
  };
}
