// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startService } from "../../src/service.ts";
import { loadRuntimeConfig } from "../../src/auth/state.ts";
import { createLog } from "../../src/log.ts";
import { startTestPeer } from "../../src/core/test-peer.ts";
import { AccountService } from "../../src/messaging/account.ts";
import type { CoreMessage } from "../../src/core/client.ts";
import type { Message } from "../../src/messaging/message.ts";
import { ChangeHub } from "../../src/events.ts";
import { McpSessions } from "../../src/mcp/sessions.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const proof = (phase: string, facts: Record<string, unknown> = {}) =>
  console.log({ time: new Date().toISOString(), phase, ...facts });
async function tool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args }, {
    timeout: 70000,
  });
  assert(!result.isError, `Tool ${name} failed`);
  assert(result.structuredContent !== undefined);
  assertEquals(result.content, [{
    type: "text",
    text: JSON.stringify(result.structuredContent),
  }]);
  return result.structuredContent as T;
}
async function provision(dir: string, name: string) {
  const joined: { contactId: number; progress: number }[] = [];
  const peer = await startTestPeer(dir, (event) => {
    if (event.kind === "SecurejoinJoinerProgress") {
      joined.push({ contactId: event.contactId, progress: event.progress });
    }
  });
  try {
    const account = new AccountService({
      use: (operation) => peer.call(operation),
    }, new ChangeHub());
    const status = await account.create({
      relay: "ci-chatmail.testrun.org",
      displayName: name,
    });
    assert(status.configured && status.accountId !== null);
    await peer.call((rpc) =>
      rpc.setConfig(status.accountId!, "mdns_enabled", "1")
    );
    return { peer, id: status.accountId, name, joined };
  } catch (error) {
    await peer.close();
    throw error;
  }
}
type Peer = Awaited<ReturnType<typeof provision>>;
async function peerHistory(peer: Peer, chat: number): Promise<CoreMessage[]> {
  return await peer.peer.call(async (rpc) => {
    const ids = await rpc.getMessageIds(peer.id, chat, false, false),
      loaded = await rpc.getMessages(peer.id, ids);
    return ids.flatMap((id) =>
      loaded[id]?.kind === "message" ? [loaded[id]] : []
    );
  });
}
async function receives(peer: Peer, text: string): Promise<CoreMessage> {
  let found: CoreMessage | undefined;
  await poll(async () => {
    const chats = await peer.peer.call((rpc) =>
      rpc.getChatlistEntries(peer.id, null, null, null)
    );
    for (const chat of chats) {
      found = (await peerHistory(peer, chat)).find((message) =>
        message.text === text
      );
      if (found) return true;
    }
    return false;
  }, 60000);
  assert(found?.showPadlock);
  return found!;
}

Deno.test("official SDK product MCP proves A/B/C encrypted rooms, receipts, waits, reconnect history, local deletion, revocation and shutdown", async () => {
  assertEquals(Deno.env.get("CHATMAIL_DOMAIN"), "ci-chatmail.testrun.org");
  const root = await fixture("m2-mcp"), run = crypto.randomUUID();
  const env = { DCMCP_DATA_DIR: `${root}/A`, DCMCP_LISTEN_PORT: "0" };
  const start = () =>
    startService(loadRuntimeConfig(env).cfg, {
      log: createLog("error", [], () => {}),
    });
  let a = await start(), b: Peer | undefined, c: Peer | undefined;
  const clients: Client[] = [];
  const connect = async (key: string) => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${lanAddress()}:${a.addr.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${key}` } } },
    );
    const client = new Client({ name: "m2-consumer", version: "0" });
    clients.push(client);
    await deadline(client.connect(transport));
    return { client, transport };
  };
  let cookie = "";
  const api = async (path: string, method = "GET", body?: unknown) => {
    const origin = `http://${lanAddress()}:${a.addr.port}`;
    return await fetch(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  };
  try {
    const setup = await api("/api/auth/setup", "POST", {
      type: "password",
      username: "operator",
      password: "m2-private-fixture-password",
    });
    assertEquals(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    await setup.body?.cancel();
    const created = await api("/api/keys", "POST", {
      name: "MCP consumer fixture",
    });
    assertEquals(created.status, 201);
    const key = await created.json();
    const sessions = a.app.mcp as McpSessions;
    const noKey = await fetch(`http://${lanAddress()}:${a.addr.port}/mcp`, {
      method: "POST",
      body: "{}",
    });
    assertEquals(noKey.status, 401);
    assertEquals(noKey.headers.get("www-authenticate"), "Bearer");
    await noKey.body?.cancel();
    assertEquals(sessions.sessionCount, 0);
    await a.app.account.create({
      relay: "ci-chatmail.testrun.org",
      displayName: `M2 A ${run}`,
    });
    b = await provision(`${root}/B`, `M2 B ${run}`);
    c = await provision(`${root}/C`, `M2 C ${run}`);
    const pair = async (peer: Peer) => {
      const invite = await a.app.account.inviteLink();
      const qr = await peer.peer.call((rpc) => rpc.checkQr(peer.id, invite));
      assertEquals(qr.kind, "askVerifyContact");
      if (qr.kind !== "askVerifyContact") {
        throw new Error("Wrong invitation kind");
      }
      await peer.peer.call((rpc) => rpc.secureJoin(peer.id, invite));
      await poll(
        () =>
          peer.joined.some((event) =>
            event.contactId === qr.contact_id && event.progress === 1000
          ),
        60000,
      );
      await poll(
        async () =>
          (await a.app.contacts.list()).some((item) =>
            item.displayName === peer.name && item.isKeyContact &&
            item.e2eeAvail
          ),
        60000,
      );
    };
    await pair(b);
    await pair(c);
    let session = await connect(key.key);
    assertEquals((await session.client.listTools()).tools.length, 9);
    const status = await tool<{ configured: boolean; address: string }>(
      session.client,
      "status",
    );
    assert(
      status.configured && status.address.endsWith("@ci-chatmail.testrun.org"),
    );
    const { contacts } = await tool<
      {
        contacts: {
          id: number;
          name: string;
          keyContact: boolean;
          encryptionAvailable: boolean;
          verified?: unknown;
        }[];
      }
    >(session.client, "list_contacts");
    const bid = contacts.find((contact) => contact.name === b!.name)!,
      cid = contacts.find((contact) => contact.name === c!.name)!;
    assert(
      bid.keyContact && bid.encryptionAvailable && cid.keyContact &&
        cid.encryptionAvailable,
    );
    assert(!("verified" in bid));
    const { chat_id: room } = await tool<{ chat_id: number }>(
      session.client,
      "create_room",
      { name: "Session room", contact_ids: [bid.id, cid.id] },
    );
    const firstText = `M2 room first text ${run}`;
    const first = await tool<{ message_id: number }>(
      session.client,
      "send_message",
      { chat_id: room, text: firstText },
    );
    const br = await receives(b, firstText), cr = await receives(c, firstText);
    const { chats } = await tool<
      {
        chats: {
          id: number;
          contactIds: number[];
          lastMessageTime: number;
          lastMessageId: number;
        }[];
      }
    >(session.client, "list_chats");
    const listedRoom = chats.find((chat) => chat.id === room)!;
    assert(
      listedRoom.contactIds.includes(bid.id) &&
        listedRoom.contactIds.includes(cid.id),
    );
    assert(
      listedRoom.lastMessageTime > 0 &&
        listedRoom.lastMessageId === first.message_id,
    );
    await b.peer.call((rpc) => rpc.markseenMsgs(b!.id, [br.id]));
    await c.peer.call((rpc) => rpc.markseenMsgs(c!.id, [cr.id]));
    await poll(
      async () =>
        (await tool<{ messages: { state: string }[] }>(
          session.client,
          "message_status",
          { message_ids: [first.message_id] },
        )).messages[0].state === "read",
      60000,
    );
    proof("mcp_room_first_text_decoded_by_B_C_and_batch_read_status");
    const started = Date.now(), replyText = `M2 delayed reply ${run}`;
    const waiting = tool<{ messages: Message[]; timedOut: boolean }>(
      session.client,
      "wait_for_messages",
      { chat_id: room, after_id: first.message_id, timeout_seconds: 60 },
    );
    await poll(() => a.app.events.listenerCount === 1);
    await pause(5000);
    const bReplyId = await b.peer.call((rpc) =>
      rpc.miscSendTextMessage(b!.id, br.chatId, replyText)
    );
    const reply = await waiting;
    assert(
      !reply.timedOut &&
        reply.messages.some((message) =>
          message.text === replyText && message.encrypted
        ),
    );
    assert(Date.now() - started < 15000);
    await poll(
      async () =>
        (await b!.peer.call((rpc) => rpc.getMessage(b!.id, bReplyId))).state ===
          28,
      60000,
    );
    const immediateStart = Date.now();
    const present = await tool<{ messages: Message[] }>(
      session.client,
      "wait_for_messages",
      { chat_id: room, after_id: first.message_id },
    );
    assert(present.messages.some((message) => message.text === replyText));
    assert(Date.now() - immediateStart < 1000);
    proof("mcp_delayed_and_already_present_wait_with_peer_read_receipt", {
      delayedMs: Date.now() - started,
    });
    const anchor = reply.messages.at(-1)!.id;
    await session.transport.terminateSession();
    await session.client.close();
    const cText1 = `M2 disconnected one ${run}`,
      cText2 = `M2 disconnected two ${run}`;
    const cLocal1 = await c.peer.call((rpc) =>
      rpc.miscSendTextMessage(c!.id, cr.chatId, cText1)
    );
    await pause(1500);
    await c.peer.call((rpc) =>
      rpc.miscSendTextMessage(c!.id, cr.chatId, cText2)
    );
    session = await connect(key.key);
    let history: Message[] = [];
    await poll(async () => {
      history =
        (await tool<{ messages: Message[] }>(session.client, "read_messages", {
          chat_id: room,
          after_id: anchor,
        })).messages;
      return history.some((message) => message.text === cText2);
    }, 60000);
    assertEquals(
      history.filter((message) =>
        message.text === cText1 || message.text === cText2
      ).map((message) => message.text),
      [cText1, cText2],
    );
    const all =
      (await tool<{ messages: Message[] }>(session.client, "read_messages", {
        chat_id: room,
        limit: 100,
      })).messages;
    assert(
      all.some((message) => message.text === firstText) &&
        all.some((message) => message.text === replyText),
    );
    const before =
      (await tool<{ messages: Message[] }>(session.client, "read_messages", {
        chat_id: room,
        before_id: history.at(-1)!.id,
        limit: 1,
      })).messages;
    assertEquals(before.length, 1);
    assertEquals(before[0].text, cText1);
    const deletedId = history.find((message) => message.text === cText1)!.id;
    await tool(session.client, "delete_messages", { message_ids: [deletedId] });
    assert(
      !(await tool<{ messages: Message[] }>(session.client, "read_messages", {
        chat_id: room,
        limit: 100,
      })).messages.some((message) => message.id === deletedId),
    );
    assert(
      (await c.peer.call((rpc) => rpc.getMessage(c!.id, cLocal1))).text ===
        cText1,
    );
    const newest = history.at(-1)!.id, timeoutStart = Date.now();
    assertEquals(
      await tool(session.client, "wait_for_messages", {
        chat_id: room,
        after_id: newest,
        timeout_seconds: 2,
      }),
      { timedOut: true, messages: [] },
    );
    assert(
      Date.now() - timeoutStart >= 1900 && Date.now() - timeoutStart < 3500,
    );
    const abort = new AbortController();
    const cancelled = session.client.callTool({
      name: "wait_for_messages",
      arguments: { chat_id: room, after_id: newest, timeout_seconds: 60 },
    }, { signal: abort.signal, timeout: 65000 }).then(() => false, () => true);
    await poll(() => a.app.events.listenerCount === 1);
    abort.abort();
    assert(await cancelled);
    await poll(() => a.app.events.listenerCount === 0);
    const directText = `M2 contact text ${run}`;
    await tool(session.client, "send_message", {
      contact_id: bid.id,
      text: directText,
    });
    await receives(b, directText);
    proof(
      "mcp_reconnect_order_full_history_local_delete_timeout_abort_contact_send",
    );
    const reusedId = session.transport.sessionId!;
    const revokedWait = session.client.callTool({
      name: "wait_for_messages",
      arguments: { chat_id: room, after_id: newest, timeout_seconds: 60 },
    }, { timeout: 4000 }).catch(() => null);
    await poll(() => a.app.events.listenerCount === 1);
    const deletion = await api(`/api/keys/${key.id}`, "DELETE");
    assertEquals(deletion.status, 204);
    await deletion.body?.cancel();
    await poll(() =>
      a.app.events.listenerCount === 0 && sessions.sessionCount === 0
    );
    const revoked = await fetch(`http://${lanAddress()}:${a.addr.port}/mcp`, {
      headers: {
        Authorization: `Bearer ${key.key}`,
        "mcp-session-id": reusedId,
      },
    });
    assertEquals(revoked.status, 401);
    assertEquals(revoked.headers.get("www-authenticate"), "Bearer");
    await revoked.body?.cancel();
    assertEquals(sessions.sessionCount, 0);
    await deadline(revokedWait, 6000);
    await session.client.close();
    await a.close();
    a = await start();
    // New key/session, same core history; local deletion remains local and durable.
    const login = await api("/api/auth/login", "POST", {
      username: "operator",
      password: "m2-private-fixture-password",
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    await login.body?.cancel();
    const next =
      await (await api("/api/keys", "POST", { name: "shutdown fixture" }))
        .json();
    session = await connect(next.key);
    const durable =
      (await tool<{ messages: Message[] }>(session.client, "read_messages", {
        chat_id: room,
        limit: 100,
      })).messages;
    assert(!durable.some((message) => message.id === deletedId));
    assert(durable.some((message) => message.text === cText2));
    const closingWait = session.client.callTool({
      name: "wait_for_messages",
      arguments: {
        chat_id: room,
        after_id: durable.at(-1)!.id,
        timeout_seconds: 60,
      },
    }, { timeout: 4000 }).catch(() => null);
    await poll(() => a.app.events.listenerCount === 1);
    await deadline(a.close(), 15000);
    assertEquals(a.app.events.listenerCount, 0);
    await deadline(closingWait, 6000);
    proof(
      "mcp_revocation_cancels_live_wait_and_reused_session_401_restart_preserves_delete_shutdown_joins",
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await a.close();
    await b?.peer.close();
    await c?.peer.close();
  }
});

Deno.test("public product MCP needs no key or browser cookie", async () => {
  const { cfg } = loadRuntimeConfig({
    DCMCP_DATA_DIR: await fixture("m2-public-mcp"),
    DCMCP_LISTEN_PORT: "0",
    DCMCP_AUTH_TYPE: "public",
  });
  const a = await startService(cfg, { log: createLog("error", [], () => {}) });
  const transport = new StreamableHTTPClientTransport(
      new URL(`http://${lanAddress()}:${a.addr.port}/mcp`),
    ),
    client = new Client({ name: "public", version: "0" });
  try {
    await client.connect(transport);
    assertEquals(
      (await tool<{ configured: boolean }>(client, "status")).configured,
      false,
    );
    await transport.terminateSession();
  } finally {
    await client.close();
    await a.close();
  }
});
