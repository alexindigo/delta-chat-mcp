// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { loadRuntimeConfig } from "../../src/auth/state.ts";
import { type CoreMessage, CoreUnavailable } from "../../src/core/client.ts";
import { startTestPeer } from "../../src/core/test-peer.ts";
import { createLog } from "../../src/log.ts";
import { startService } from "../../src/service.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";
import { proveMainShutdown } from "../service_process.ts";
import { CoreProcess } from "../../src/core/process.ts";
import type { CoreClient, CoreRpc } from "../../src/core/client.ts";
import { AccountService } from "../../src/messaging/account.ts";
import { ChangeHub } from "../../src/events.ts";
import { McpTransport } from "../../src/mcp/transport.ts";
import { publicKeys } from "../account_keys.ts";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startDeltaChat } from "@deltachat/stdio-rpc-server";
import { once } from "node:events";
import type { Message } from "../../src/messaging/message.ts";

type Peer = Awaited<ReturnType<typeof startTestPeer>>;
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const evidence = (phase: string, facts: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), phase, ...facts }),
  );
async function provision(dir: string, name: string) {
  const joined: { contactId: number; progress: number }[] = [];
  const onEvent = (
    event: Parameters<Parameters<typeof startTestPeer>[1]>[0],
  ) => {
    if (event.kind === "SecurejoinJoinerProgress") {
      joined.push({ contactId: event.contactId, progress: event.progress });
    }
  };
  let peer = await startTestPeer(dir, onEvent);
  try {
    // Model an ambiguous provider reply: actual transport setup committed, but
    // the caller received an error. Everything except that reply is real core.
    const account = new AccountService({
      use<T>(operation: (rpc: CoreRpc) => Promise<T>) {
        return peer.call((rpc) =>
          operation({
            ...rpc,
            addTransportFromQr: async (id, text) => {
              await rpc.addTransportFromQr(id, text);
              throw new Error("Injected ambiguous provider reply");
            },
          })
        );
      },
    }, new ChangeHub());
    await assertRejects(
      () =>
        account.create({ relay: "ci-chatmail.testrun.org", displayName: name }),
      Error,
      "Injected ambiguous provider reply",
    );
    const status = await account.status();
    assert(status.configured && status.accountId !== null);
    const id = status.accountId;
    assertEquals(account.configured, true);
    await account.inviteLink(); // Generate actual keys through the normal API.
    const keys = await publicKeys(dir);
    assert(keys.length > 0);
    await assertRejects(
      () =>
        account.create({
          relay: "ci-chatmail.testrun.org",
          displayName: "Must not replace",
        }),
      Error,
      "already exists",
    );
    await peer.close();
    peer = await startTestPeer(dir, onEvent);
    assertEquals(await peer.call((rpc) => rpc.getAllAccountIds()), [id]);
    assertEquals(await publicKeys(dir), keys);
    assertEquals(
      await peer.call((rpc) => rpc.getConfig(id, "displayname")),
      name,
    );
    evidence("ambiguous_provider_state_and_keys_preserved", {
      configured: true,
      sameId: true,
      keysPresentAndUnchanged: true,
    });
    await peer.call((rpc) => rpc.setConfig(id, "mdns_enabled", "1"));
    await peer.call((rpc) => rpc.startIo(id));
    assert(await peer.call((rpc) => rpc.isConfigured(id)));
    return { peer, id, name, joined };
  } catch (error) {
    await peer.close();
    throw error;
  }
}
async function interruptedIdentity(accountsDir: string, displayName: string) {
  let core = new CoreProcess({ accountsDir });
  let attempts = 0;
  const client: CoreClient = {
    use<T>(operation: (rpc: CoreRpc) => Promise<T>) {
      return core.use((rpc) =>
        operation({
          ...rpc,
          addTransportFromQr: () => {
            attempts++;
            return Promise.reject(new Error("Injected provider unavailable"));
          },
        })
      );
    },
  };
  try {
    await core.start();
    let account = new AccountService(client, new ChangeHub());
    const input = { relay: "ci-chatmail.testrun.org", displayName };
    await assertRejects(
      () => account.create(input),
      Error,
      "Injected provider unavailable",
    );
    const status = await account.status();
    assert(status.accountId !== null && !status.configured);
    const keys = await publicKeys(accountsDir);
    await assertRejects(
      () => account.create(input),
      Error,
      "Injected provider unavailable",
    );
    await core.close();
    core = new CoreProcess({ accountsDir });
    await core.start();
    account = new AccountService(client, new ChangeHub());
    await assertRejects(
      () => account.create(input),
      Error,
      "Injected provider unavailable",
    );
    assertEquals(attempts, 3);
    assertEquals((await account.status()).accountId, status.accountId);
    assertEquals(await publicKeys(accountsDir), keys);
    evidence("provider_failure_immediate_and_restart_retry", {
      attempts,
      sameId: true,
      actualCore: true,
    });
    return status.accountId;
  } finally {
    await core.close();
  }
}
async function peerMessages(
  peer: Peer,
  account: number,
  chat: number,
): Promise<CoreMessage[]> {
  return await peer.call(async (rpc) => {
    const ids = await rpc.getMessageIds(account, chat, false, false);
    const loaded = await rpc.getMessages(account, ids);
    return ids.flatMap((id) =>
      loaded[id]?.kind === "message" ? [loaded[id]] : []
    );
  });
}
async function peerReceives(
  peer: Peer,
  account: number,
  chat: number,
  text: string,
) {
  let found: CoreMessage | undefined;
  await poll(async () => {
    found = (await peerMessages(peer, account, chat)).find((message) =>
      message.text === text
    );
    return !!found;
  }, 60000);
  assertEquals(found!.text, text);
  assertEquals(found!.showPadlock, true);
  return found!;
}
async function peerFindsRoom(peer: Peer, account: number, text: string) {
  let found: CoreMessage | undefined;
  await poll(async () => {
    const chats = await peer.call((rpc) =>
      rpc.getChatlistEntries(account, null, null, null)
    );
    for (const chat of chats) {
      found = (await peerMessages(peer, account, chat)).find((message) =>
        message.text === text
      );
      if (found) break;
    }
    return !!found;
  }, 60000);
  assertEquals(found!.showPadlock, true);
  return found!;
}

Deno.test("real A/B/C relay peers prove encrypted messaging, idle persistence, receipts, waits, recovery and local deletion", async () => {
  assertEquals(Deno.env.get("CHATMAIL_DOMAIN"), "ci-chatmail.testrun.org");
  const root = await fixture("m1-online"), run = crypto.randomUUID();
  const env = {
    DCMCP_DATA_DIR: `${root}/A`,
    DCMCP_LISTEN_PORT: "0",
    DCMCP_AUTH_TYPE: "public",
  };
  const logs: string[] = [];
  const startA = async () => {
    const { cfg, secretPinned } = loadRuntimeConfig(env);
    const service = await startService(cfg, {
      secretPinned,
      log: createLog("debug", [], (line) => logs.push(line)),
    });
    try {
      const listenerBaseline = service.app.events.listenerCount;
      assertEquals(
        listenerBaseline,
        1,
        "known service-owned RoomRouting startup listener",
      );
      const transport = service.app.mcp;
      assert(transport instanceof McpTransport);
      assertEquals(transport.legacySessionCount, 0);
      return { ...service, listenerBaseline, transport };
    } catch (error) {
      await service.close();
      throw error;
    }
  };
  const allocatedId = await interruptedIdentity(
    `${root}/A/accounts`,
    `M1 A ${run}`,
  );
  let a = await startA();
  let b: Awaited<ReturnType<typeof provision>> | undefined;
  let c: Awaited<ReturnType<typeof provision>> | undefined;
  const incoming = async (chat: number, text: string) => {
    let result:
      | Awaited<ReturnType<typeof a.app.chats.messages>>[number]
      | undefined;
    await poll(async () => {
      result = (await a.app.chats.messages(chat, { limit: 1000 })).find(
        (message) => message.text === text,
      );
      return !!result;
    }, 60000);
    assertEquals(result!.text, text);
    assertEquals(result!.encrypted, true);
    return result!;
  };
  const failures: unknown[] = [];
  try {
    evidence("provision_start", { fixture: root });
    const identity = await a.app.account.create({
      relay: "ci-chatmail.testrun.org",
      displayName: `M1 A ${run}`,
    });
    assertEquals(identity.configured, true);
    assertEquals(identity.accountId, allocatedId);
    evidence("same_allocated_identity_configured_by_service", {
      sameId: true,
      configured: identity.configured,
    });
    assert(identity.address?.endsWith("@ci-chatmail.testrun.org"));
    b = await provision(`${root}/B`, `M1 B ${run}`);
    c = await provision(`${root}/C`, `M1 C ${run}`);
    evidence("three_identities_configured", {
      count: 3,
      relay: "ci-chatmail.testrun.org",
    });
    const pair = async (other: NonNullable<typeof b>) => {
      const invite = await a.app.account.inviteLink();
      const qr = await other.peer.call((rpc) => rpc.checkQr(other.id, invite));
      assertEquals(qr.kind, "askVerifyContact");
      if (qr.kind !== "askVerifyContact") {
        throw new Error("Wrong pairing QR kind");
      }
      assert(qr.fingerprint.length > 0);
      const chat = await other.peer.call((rpc) =>
        rpc.secureJoin(other.id, invite)
      );
      await poll(
        () =>
          other.joined.some((event) =>
            event.contactId === qr.contact_id && event.progress === 1000
          ),
        60000,
      );
      await poll(
        async () =>
          (await a.app.contacts.list()).some((contact) =>
            contact.displayName === other.name && contact.isKeyContact &&
            contact.e2eeAvail
          ),
        60000,
      );
      const contact = (await a.app.contacts.list()).find((item) =>
        item.displayName === other.name
      )!;
      const remoteContact = (await other.peer.call((rpc) =>
        rpc.getContacts(other.id, 0, null)
      )).find((item) => item.id === qr.contact_id);
      assert(remoteContact?.isKeyContact && remoteContact.e2eeAvail);
      return { chat, contactId: contact.id };
    };
    const bp = await pair(b), cp = await pair(c);
    const keysBeforeRestart = await publicKeys(`${root}/A/accounts`);
    assert(keysBeforeRestart.length > 0);
    evidence("intended_securejoin_complete", {
      peers: 2,
      joinerProgress: 1000,
      encryptionReady: true,
    });
    const sent = await a.app.send.sendTextToContact(
      bp.contactId,
      `M1 encrypted A to B ${run}`,
    );
    const bReceived = await peerReceives(
      b.peer,
      b.id,
      bp.chat,
      `M1 encrypted A to B ${run}`,
    );
    await poll(
      async () =>
        (await a.app.send.status([sent.messageId]))[0].state === "delivered",
      60000,
    );
    await b.peer.call((rpc) => rpc.markseenMsgs(b!.id, [bReceived.id]));
    await poll(
      async () =>
        (await a.app.send.status([sent.messageId]))[0].state === "read",
      60000,
    );
    const idleText = `M1 encrypted idle B to A ${run}`;
    const bSent = await b.peer.call((rpc) =>
      rpc.miscSendTextMessage(b!.id, bp.chat, idleText)
    );
    await pause(1000); // No browser/MCP client or message subscription is attached.
    assertEquals(a.app.events.listenerCount, a.listenerBaseline);
    const idle = await incoming(sent.chatId, idleText);
    await a.app.chats.markSeen([idle.id]);
    await poll(
      async () =>
        (await b!.peer.call((rpc) => rpc.getMessage(b!.id, bSent))).state ===
          28,
      60000,
    );
    evidence("bidirectional_encrypted_consumers_and_receipts", {
      decodedAtBothEnds: true,
      delivered: true,
      readAtBothEnds: true,
    });
    await a.app.delete.deleteMessages([idle.id]);
    assert(
      !(await a.app.chats.messages(sent.chatId, { limit: 1000 })).some(
        (message) => message.id === idle.id,
      ),
    );
    assertEquals(
      (await b.peer.call((rpc) => rpc.getMessage(b!.id, bSent))).text,
      idleText,
    );
    evidence("local_delete_preserves_peer_copy");
    const oldPid = a.corePid()!;
    await deadline(a.close(), 15000);
    assertEquals(a.app.events.listenerCount, 0);
    assertEquals(a.transport.legacySessionCount, 0);
    await assertRejects(
      () => Promise.resolve().then(() => Deno.kill(oldPid, 0)),
      Deno.errors.NotFound,
    );
    evidence(
      "configured_main_sigterm",
      await proveMainShutdown(`${root}/A`, true),
    );
    await b.peer.call((rpc) =>
      rpc.miscSendTextMessage(b!.id, bp.chat, `M1 while A down ${run}`)
    );
    a = await startA();
    assertEquals(a.app.health().configured, true);
    assertEquals((await a.app.account.status()).accountId, allocatedId);
    assertEquals(await publicKeys(`${root}/A/accounts`), keysBeforeRestart);
    await incoming(sent.chatId, `M1 while A down ${run}`);
    evidence("message_received_across_service_restart");
    let anchor =
      (await a.app.chats.messages(sent.chatId, { limit: 1000 })).at(-1)!.id;
    const start = Date.now();
    await Promise.all([
      a.app.chats.waitForMessage(sent.chatId, anchor, 60000).then((result) => {
        assert(!result.timedOut);
        assert(
          result.messages.some((message) =>
            message.text === `M1 delayed reply ${run}` && message.encrypted
          ),
        );
        assert(Date.now() - start < 15000);
      }),
      (async () => {
        await poll(() => a.app.events.listenerCount === a.listenerBaseline + 1);
        await pause(5000);
        await b!.peer.call((rpc) =>
          rpc.miscSendTextMessage(b!.id, bp.chat, `M1 delayed reply ${run}`)
        );
      })(),
    ]);
    assertEquals(a.app.events.listenerCount, a.listenerBaseline);
    const replyMs = Date.now() - start;
    anchor =
      (await a.app.chats.messages(sent.chatId, { limit: 1000 })).at(-1)!.id;
    await b.peer.call((rpc) =>
      rpc.miscSendTextMessage(b!.id, bp.chat, `M1 already present ${run}`)
    );
    const present = await incoming(sent.chatId, `M1 already present ${run}`);
    const immediateStart = Date.now();
    assert(
      (await a.app.chats.waitForMessage(sent.chatId, anchor, 60000)).messages
        .some((message) => message.text === present.text),
    );
    const immediateMs = Date.now() - immediateStart;
    assertEquals(a.app.events.listenerCount, a.listenerBaseline);
    assert(immediateMs < 1000);
    anchor =
      (await a.app.chats.messages(sent.chatId, { limit: 1000 })).at(-1)!.id;
    const timeoutStart = Date.now();
    const timedWait = a.app.chats.waitForMessage(sent.chatId, anchor, 2000);
    await poll(() => a.app.events.listenerCount === a.listenerBaseline + 1);
    assertEquals(await timedWait, {
      timedOut: true,
      messages: [],
    });
    const timeoutMs = Date.now() - timeoutStart;
    assertEquals(a.app.events.listenerCount, a.listenerBaseline);
    assert(timeoutMs >= 1900 && timeoutMs < 3000);
    const controller = new AbortController();
    const aborted = assertRejects(
      () =>
        a.app.chats.waitForMessage(
          sent.chatId,
          anchor,
          60000,
          controller.signal,
        ),
      DOMException,
    );
    await poll(() => a.app.events.listenerCount === a.listenerBaseline + 1);
    await pause(100);
    controller.abort();
    await aborted;
    assertEquals(a.app.events.listenerCount, a.listenerBaseline);
    evidence("real_wait_outcomes", {
      replyMs,
      immediateMs,
      timeoutMs,
      listenersAfterAbort: a.app.events.listenerCount - a.listenerBaseline,
      totalListenersAfterAbort: a.app.events.listenerCount,
      serviceOwnedListenerBaseline: a.listenerBaseline,
    });
    const crashPid = a.corePid()!;
    await Promise.all([
      a.app.chats.waitForMessage(sent.chatId, anchor, 60000).then((result) => {
        assert(
          result.messages.some((message) =>
            message.text === `M1 after crash ${run}` && message.encrypted
          ),
        );
      }),
      (async () => {
        await poll(() => a.app.events.listenerCount === a.listenerBaseline + 1);
        Deno.kill(crashPid, "SIGKILL");
        await poll(() => a.app.health().core === "restarting");
        const health = await fetch(
          `http://${lanAddress()}:${a.addr.port}/_/health`,
        );
        assertEquals((await health.json()).core, "restarting");
        await assertRejects(() => a.app.chats.list(), CoreUnavailable);
        await b!.peer.call((rpc) =>
          rpc.miscSendTextMessage(b!.id, bp.chat, `M1 after crash ${run}`)
        );
        await poll(() => a.app.health().core === "ready", 15000);
        assert(a.corePid() !== crashPid);
      })(),
    ]);
    assertEquals(a.app.events.listenerCount, a.listenerBaseline);
    evidence("crash_recovery_and_pending_wait_recheck");
    const room = await a.app.rooms.createRoom(`M1 room ${run}`, [
      bp.contactId,
      cp.contactId,
    ]);
    await a.app.send.sendText(room.chatId, `M1 room first ${run}`);
    const bRoom = await peerFindsRoom(b.peer, b.id, `M1 room first ${run}`);
    const cRoom = await peerFindsRoom(c.peer, c.id, `M1 room first ${run}`);
    assert(bRoom.chatId > 0 && cRoom.chatId > 0);
    await c.peer.call((rpc) =>
      rpc.miscSendTextMessage(c!.id, cRoom.chatId, `M1 room C reply ${run}`)
    );
    await incoming(room.chatId, `M1 room C reply ${run}`);
    const history = await a.app.chats.messages(room.chatId, { limit: 1000 });
    assert(history.some((message) => message.text === `M1 room first ${run}`));
    const db = new DatabaseSync(`${root}/A/app.sqlite`, { readOnly: true });
    try {
      assertEquals(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        ).all().map((row) => row.name),
        ["api_keys", "room_routing", "schema_version"],
      );
    } finally {
      db.close();
    }
    evidence("three_party_room_consumers_and_access_only_schema", {
      firstReceivedBy: 2,
      replyReceivedByA: true,
    });
    // J1 exercises the real MCP wire and browser history JSON with the SAME
    // throwaway peers. Only the test-owned B process is replaced with a stock
    // raw peer here, to exercise sendMsg quotes/forwardMessages without widening
    // the product facade or shared test-peer helper.
    await b.peer.close();
    const stock = startDeltaChat(`${root}/B`, {
      disableEnvPath: true,
      muteStdErr: true,
    });
    const stockClosed = Promise.all([
      once(stock.transport.input, "close"),
      once(stock.transport.output, "close"),
    ]);
    const client = new Client({ name: "j1-full-body-consumer", version: "0" });
    try {
      await stock.rpc.getSystemInfo();
      await stock.rpc.startIo(b.id);
      const origin = `http://${lanAddress()}:${a.addr.port}`;
      await deadline(
        client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)),
        ),
      );
      const tool = async <T>(name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args }, {
          timeout: 70000,
        });
        assert(!result.isError, `J1 tool ${name} failed`);
        assert(result.structuredContent !== undefined);
        assertEquals(result.content, [{
          type: "text",
          text: JSON.stringify(result.structuredContent),
        }]);
        return result.structuredContent as T;
      };
      const longText = (direction: string) =>
        `J1 ${direction} ${run}\n` +
        (` leading & < > " ' Unicode π 日本 😀 literal [...]\n` +
          `> quoted-looking line & < >\n\n` +
          `https://example.org/path?x=1&y=2 foo+tag@example.org\n` +
          "a".repeat(190) + "\n").repeat(24) +
        `J1-END-${direction}-${run}`;
      const fullIncoming = longText("incoming");
      assert(fullIncoming.length >= 6200);
      const lastId = (await a.app.chats.messages(room.chatId)).at(-1)!.id;
      const waiting = tool<{ messages: Message[]; timedOut: boolean }>(
        "wait_for_messages",
        {
          chat_id: room.chatId,
          after_id: lastId,
          timeout_seconds: 60,
        },
      );
      await poll(() => a.app.events.listenerCount === a.listenerBaseline + 1);
      const peerSent = await stock.rpc.miscSendTextMessage(
        b.id,
        bRoom.chatId,
        fullIncoming,
      );
      const waitResult = await waiting;
      assertEquals(waitResult.timedOut, false);
      const waited = waitResult.messages.find((m) =>
        !m.fromSelf && m.text === fullIncoming
      );
      assert(waited, "Complete incoming body must reach MCP wait consumer");
      const exact = (path: string, value: Message, expected: string) => {
        assertEquals(value.text, expected);
        assertEquals(value.textComplete, true);
        assertEquals(value.html, undefined);
        assertEquals(
          value.text.endsWith(
            `J1-END-${
              path === "outgoing-read" ? "outgoing" : "incoming"
            }-${run}`,
          ),
          true,
        );
        evidence(`j1_${path}_exact`, {
          exactEquality: value.text === expected,
          expectedLength: expected.length,
          actualLength: value.text.length,
          textComplete: value.textComplete,
          marker: expected.slice(expected.lastIndexOf("J1-END-")),
          messageId: value.id,
        });
      };
      exact("wait", waited, fullIncoming);
      const read = await tool<{ messages: Message[] }>("read_messages", {
        chat_id: room.chatId,
        after_id: lastId,
        limit: 100,
      });
      exact(
        "read",
        read.messages.find((m) => m.id === waited.id)!,
        fullIncoming,
      );
      const browserResponse = await fetch(
        `${origin}/api/chats/${room.chatId}/messages`,
        { signal: AbortSignal.timeout(10000) },
      );
      assertEquals(browserResponse.status, 200);
      const browser = await browserResponse.json() as { messages: Message[] };
      exact(
        "browser-json",
        browser.messages.find((m) => m.id === waited.id)!,
        fullIncoming,
      );
      const peerDisplay = await stock.rpc.getMessage(b.id, peerSent);
      assert(peerDisplay.hasHtml && peerDisplay.text !== fullIncoming);
      evidence("j1_display_is_not_complete_body", {
        displayLength: peerDisplay.text.length,
        fullLength: fullIncoming.length,
        hasHtml: peerDisplay.hasHtml,
      });
      const fullOutgoing = longText("outgoing");
      assert(fullOutgoing.length >= 6200);
      const outgoing = await tool<{ message_id: number }>("send_message", {
        chat_id: room.chatId,
        text: fullOutgoing,
      });
      const readback = await tool<{ messages: Message[] }>("read_messages", {
        chat_id: room.chatId,
        after_id: waited.id,
        limit: 100,
      });
      exact(
        "outgoing-read",
        readback.messages.find((m) => m.id === outgoing.message_id)!,
        fullOutgoing,
      );
      const quoteText = `J1 real quoted reply ${run}`;
      await stock.rpc.sendMsg(b.id, bRoom.chatId, {
        text: quoteText,
        html: null,
        viewtype: "Text",
        file: null,
        filename: null,
        location: null,
        overrideSenderName: "J1 peer alias",
        quotedMessageId: bRoom.id,
        quotedText: null,
      });
      const quoted = await incoming(room.chatId, quoteText);
      assertEquals(quoted.quote, {
        text: `M1 room first ${run}`,
        messageId: (history.find((m) => m.text === `M1 room first ${run}`))!.id,
        authorName: history.find((m) => m.text === `M1 room first ${run}`)!
          .fromName,
      });
      assertEquals(quoted.fromName, "J1 peer alias");
      const peerSender = await stock.rpc.getContact(b.id, 1);
      assertEquals(quoted.fromAddress, peerSender.address);
      assertEquals([quoted.isBot, quoted.isInfo, quoted.isForwarded], [
        false,
        false,
        false,
      ]);
      evidence("j1_real_quote_mapping", {
        exactEquality: true,
        quote: quoted.quote,
        fromName: quoted.fromName,
        canonicalAddressEqual: quoted.fromAddress === peerSender.address,
      });
      await stock.rpc.forwardMessages(b.id, [bReceived.id], bRoom.chatId);
      const forwarded = await incoming(
        room.chatId,
        `M1 encrypted A to B ${run}`,
      );
      assertEquals(forwarded.isForwarded, true);
      assertEquals(forwarded.fromAddress, peerSender.address);
      evidence("j1_real_forward_mapping", {
        isForwarded: forwarded.isForwarded,
        canonicalAddressEqual: true,
        messageId: forwarded.id,
      });
    } finally {
      await client.close();
      stock.close();
      await deadline(stockClosed, 10000);
    }
    assert(!logs.some((line) => line.includes(run))); // Message bodies never enter structured service logs.
    evidence("all_messaging_outcomes_observed");
  } catch (error) {
    failures.push(error);
  } finally {
    const results = await Promise.allSettled([
      a.close(),
      b?.peer.close(),
      c?.peer.close(),
    ]);
    try {
      assertEquals(a.app.events.listenerCount, 0);
      assertEquals(a.transport.legacySessionCount, 0);
    } catch (error) {
      failures.push(error);
    }
    if (results.some((result) => result.status === "rejected")) {
      failures.push(new Error("Owned online fixture cleanup failed"));
    }
    evidence("owned_fixtures_cleanup", {
      failures: results.filter((result) => result.status === "rejected").length,
    });
  }
  if (failures.length) {
    throw new AggregateError(failures, "Online messaging proof failed");
  }
});
