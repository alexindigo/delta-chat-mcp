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
import { publicKeys } from "../account_keys.ts";

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
    return await startService(cfg, {
      secretPinned,
      log: createLog("debug", [], (line) => logs.push(line)),
    });
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
    assertEquals(a.app.events.listenerCount, 0);
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
        await pause(5000);
        await b!.peer.call((rpc) =>
          rpc.miscSendTextMessage(b!.id, bp.chat, `M1 delayed reply ${run}`)
        );
      })(),
    ]);
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
    assert(immediateMs < 1000);
    anchor =
      (await a.app.chats.messages(sent.chatId, { limit: 1000 })).at(-1)!.id;
    const timeoutStart = Date.now();
    assertEquals(await a.app.chats.waitForMessage(sent.chatId, anchor, 2000), {
      timedOut: true,
      messages: [],
    });
    const timeoutMs = Date.now() - timeoutStart;
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
    await pause(100);
    controller.abort();
    await aborted;
    assertEquals(a.app.events.listenerCount, 0);
    evidence("real_wait_outcomes", {
      replyMs,
      immediateMs,
      timeoutMs,
      listenersAfterAbort: 0,
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
    assertEquals(a.app.events.listenerCount, 0);
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
        ["api_keys", "schema_version"],
      );
    } finally {
      db.close();
    }
    evidence("three_party_room_consumers_and_access_only_schema", {
      firstReceivedBy: 2,
      replyReceivedByA: true,
    });
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
