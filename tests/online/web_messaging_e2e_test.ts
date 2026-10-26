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
import { ChangeHub } from "../../src/events.ts";
import type { CoreMessage } from "../../src/core/client.ts";
import type { Message } from "../../src/messaging/message.ts";
import { Cdp } from "../cdp.ts";
import { click, key, productBuild, type } from "../browser.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";
import { decodedImage, imageFixtures } from "../image_fixtures.ts";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fill(page: Cdp, selector: string, text: string) {
  await click(page, selector);
  await key(page, "a", 2);
  await key(page, "Backspace");
  await page.send("Input.insertText", { text });
}
async function peer(dir: string, name: string) {
  const joined: number[] = [];
  const core = await startTestPeer(dir, (event) => {
    if (event.kind === "SecurejoinJoinerProgress" && event.progress === 1000) {
      joined.push(event.contactId);
    }
  });
  const account = new AccountService(
    { use: (fn) => core.call(fn) },
    new ChangeHub(),
  );
  try {
    const status = await account.create({
      relay: "ci-chatmail.testrun.org",
      displayName: name,
    });
    await core.call((rpc) =>
      rpc.setConfig(status.accountId!, "mdns_enabled", "1")
    );
    return { core, account, id: status.accountId!, name, joined };
  } catch (error) {
    await core.close();
    throw error;
  }
}
type Peer = Awaited<ReturnType<typeof peer>>;
async function history(peer: Peer, chat: number): Promise<CoreMessage[]> {
  return await peer.core.call(async (rpc) => {
    const ids = await rpc.getMessageIds(peer.id, chat, false, false),
      values = await rpc.getMessages(peer.id, ids);
    return ids.flatMap((id) =>
      values[id]?.kind === "message" ? [values[id]] : []
    );
  });
}
async function receive(peer: Peer, text: string) {
  let found: CoreMessage | undefined;
  await poll(async () => {
    for (
      const chat of await peer.core.call((rpc) =>
        rpc.getChatlistEntries(peer.id, null, null, null)
      )
    ) {
      found = (await history(peer, chat)).find((message) =>
        message.text === text
      );
      if (found) return true;
    }
    return false;
  }, 60000);
  assert(found!.showPadlock);
  return found!;
}
async function tool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name} must succeed`);
  return result.structuredContent as T;
}
async function fullShot(page: Cdp, path: string, regions: string[]) {
  await page.evaluate("scrollTo({top:0,behavior:'instant'})");
  await page.evaluate("document.fonts.ready");
  const metrics = await page.send("Page.getLayoutMetrics"),
    size = await page.evaluate<{ width: number; height: number }>(
      "({width:Math.max(document.documentElement.clientWidth,document.documentElement.scrollWidth),height:Math.max(innerHeight,document.documentElement.scrollHeight,document.body.scrollHeight)})",
    );
  await Deno.writeTextFile(
    path.replace(".png", "-capture.json"),
    JSON.stringify(
      { cssContentSize: metrics.cssContentSize, document: size },
      null,
      2,
    ),
  );
  const footerEnd = await page.evaluate<number>(
    "Math.max(innerHeight,document.querySelector('.app-footer').getBoundingClientRect().bottom+scrollY)",
  );
  assert(
    size.height <= Math.ceil(footerEnd) + 1,
    "Contained history and accessibility labels must not enlarge the document beyond its footer",
  );
  const save = async (file: string, clip: Record<string, number>) => {
    const image = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 },
    });
    await Deno.writeFile(
      file,
      Uint8Array.from(atob(image.data as string), (c) => c.charCodeAt(0)),
    );
  };
  await save(path, { x: 0, y: 0, width: size.width, height: size.height });
  for (const [i, selector] of regions.entries()) {
    const rect = await page.evaluate<Record<string, number>>(
      `(()=>{const r=document.querySelector(${
        JSON.stringify(selector)
      }).getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}})()`,
    );
    await save(path.replace(".png", `-region${i}-review.png`), rect);
  }
}
async function theme(page: Cdp, id: string) {
  await click(page, `[data-theme="${id}"]`);
  await poll(() =>
    page.evaluate<boolean>(
      `document.querySelector('[data-theme="${id}"]')?.getAttribute('aria-pressed')==='true'`,
    )
  );
}
async function geometry(page: Cdp) {
  const result = await page.evaluate<
    {
      headerDelta: number;
      historyBottom: number;
      composerTop: number;
      historyLeft: number;
      composerLeft: number;
      historyRight: number;
      composerRight: number;
      overflow: boolean;
    }
  >(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),a=r('.chat-index-header'),b=r('.conversation-header'),h=r('.message-history'),c=r('.composer-row');return {headerDelta:a.bottom-b.bottom,historyBottom:h.bottom,composerTop:c.top,historyLeft:h.left,composerLeft:c.left,historyRight:h.right,composerRight:c.right,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(Math.abs(result.headerDelta) < .5);
  assert(Math.abs(result.historyBottom - result.composerTop) < .5);
  assert(Math.abs(result.historyLeft - result.composerLeft) < .5);
  assert(Math.abs(result.historyRight - result.composerRight) < .5);
  assert(!result.overflow);
  return result;
}

Deno.test("real browser messaging: identity, invitations, requests, live encrypted peers, MCP history, pagination, drafts, restart and full themes", async () => {
  assertEquals(Deno.env.get("CHATMAIL_DOMAIN"), "ci-chatmail.testrun.org");
  await productBuild();
  const root = await fixture("m3-online");
  await Deno.mkdir("artifacts/m3", { recursive: true });
  const evidence = await Deno.makeTempDir({
    dir: "artifacts/m3",
    prefix: "messaging-",
  });
  const reservation = Deno.listen({ hostname: "0.0.0.0", port: 0 }),
    port = reservation.addr.port;
  reservation.close();
  const env = { DCMCP_DATA_DIR: `${root}/A`, DCMCP_LISTEN_PORT: String(port) };
  const start = () =>
    startService(loadRuntimeConfig(env).cfg, {
      log: createLog("error", [], () => {}),
    });
  let a = await start(),
    b: Peer | undefined,
    c: Peer | undefined,
    page: Cdp | undefined,
    client: Client | undefined;
  const facts: Record<string, unknown> = { evidence };
  const record = (phase: string, value: unknown = true) => {
    facts[phase] = value;
    console.log({ time: new Date().toISOString(), phase, value });
  };
  try {
    await a.app.auth.setup({
      type: "password",
      username: "operator",
      password: "private-m3-browser-password",
    });
    const apiKey = await a.app.apiKeys.create("M3 private MCP fixture");
    page = await Cdp.launch(
      await fixture("m3-browser"),
      lanAddress(),
      evidence,
    );
    const browser = page, origin = `http://delta-chat-mcp.test:${port}`;
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.send("Page.navigate", { url: `${origin}/identity` });
    await type(browser, "#username", "operator");
    await type(browser, "#password", "private-m3-browser-password");
    await click(browser, '[data-action="access-submit"]');
    await type(browser, "#display-name", " ");
    await click(browser, "#public-relay");
    await key(browser, "End");
    await key(browser, "Enter");
    await type(browser, "#relay", "DCACCOUNT:ci-chatmail.testrun.org");
    await click(browser, '[data-action="create-identity"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('.identity-form [role=alert]')",
      )
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#display-name').value"),
      " ",
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#relay').value"),
      "DCACCOUNT:ci-chatmail.testrun.org",
    );
    await browser.screenshot(`${evidence}/identity-error-working.png`);
    await fill(browser, "#display-name", "Relay desk");
    await click(browser, '[data-action="create-identity"]');
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('[data-identity-address]')?.textContent.includes('@ci-chatmail.testrun.org')",
        ),
      120000,
    );
    assertEquals(await browser.evaluate("isSecureContext"), false);
    assertEquals(
      await browser.evaluate("location.hostname"),
      "delta-chat-mcp.test",
    );
    record(
      "browserCreatedRealIdentityWithFullUri",
      (await a.app.account.status()).configured,
    );
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-invite-qr]')?.naturalWidth",
      )
    );
    for (const mode of ["light", "dark"]) {
      await theme(browser, mode);
      await browser.screenshot(`${evidence}/identity-${mode}-working.png`);
    }
    await click(browser, 'a[href="/contacts"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('#own-invite')?.value",
      )
    );
    const invite = await browser.evaluate<string>(
      "document.querySelector('#own-invite').value",
    );
    assert(invite.startsWith("https://i.delta.chat/#"));
    const svg = await browser.evaluate<string>(
      "decodeURIComponent(document.querySelector('[data-invite-qr]').src.split(',').slice(1).join(','))",
    );
    b = await peer(`${root}/B`, "Phone fixture");
    c = await peer(`${root}/C`, "Second contact");
    assertEquals(svg, await b.core.call((rpc) => rpc.createQrSvg(invite)));
    assert(
      await browser.evaluate<boolean>(
        "document.querySelector('[data-invite-qr]').complete && document.querySelector('[data-invite-qr]').naturalWidth>0",
      ),
    );
    await click(browser, '[data-action="copy-invite"]');
    await click(browser, "#contact-invite");
    await key(browser, "v", 2);
    await poll(() =>
      browser.evaluate<boolean>(
        `document.querySelector('#contact-invite').value===${
          JSON.stringify(invite)
        }`,
      )
    );
    await fill(browser, "#contact-invite", "");
    record("actualCoreSvgAndHttpCopyPaste");
    // SecureJoin auto-accepts contacts. A stock-core public vCard instead lets
    // private peers send genuine encrypted unsolicited requests. Open A's
    // durable account only while its composed service is fully stopped.
    await a.close();
    const cardPeer = await startTestPeer(`${root}/A/accounts`, () => {});
    let selfCard: string;
    try {
      selfCard = await cardPeer.selfCard();
    } finally {
      await cardPeer.close();
    }
    a = await start();
    await poll(
      () =>
        browser.evaluate<boolean>(
          "!document.querySelector('.connection-status')?.textContent.includes('interrupted')",
        ),
      20000,
    );
    const requestFrom = async (p: Peer, text: string) => {
      const imported = await p.core.importCard(p.id, selfCard);
      assertEquals(imported.length, 1);
      const chat = await p.core.call((rpc) =>
        rpc.createChatByContactId(p.id, imported[0])
      );
      const id = await p.core.call((rpc) =>
        rpc.miscSendTextMessage(p.id, chat, text)
      );
      return { chat, id };
    };
    await requestFrom(b, "Hello from your phone");
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('.contact-requests')?.textContent.includes('Phone fixture')",
        ),
      60000,
    );
    const requestChat = (await a.app.chats.list()).find((chat) =>
      chat.isContactRequest && chat.name === b!.name
    )!;
    assert(requestChat);
    await browser.screenshot(`${evidence}/request-working.png`);
    await click(
      browser,
      `[data-request-id="${requestChat.id}"] [data-action="accept-request"]`,
    );
    await poll(
      async () => !(await a.app.chats.get(requestChat.id)).isContactRequest,
      10000,
    );
    record("acceptedRealContactRequest");
    await requestFrom(c, "A second contact request");
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('.contact-requests')?.textContent.includes('Second contact')",
        ),
      60000,
    );
    const blockChat = (await a.app.chats.list()).find((chat) =>
      chat.isContactRequest && chat.name === c!.name
    )!;
    await click(
      browser,
      `[data-request-id="${blockChat.id}"] [data-action="block-request"]`,
    );
    await poll(() =>
      browser.evaluate<boolean>(
        `!document.querySelector('[data-request-id="${blockChat.id}"]')`,
      )
    );
    record("blockedRealContactRequest");
    const bInvite = await b.account.inviteLink();
    await fill(browser, "#contact-invite", bInvite);
    await click(browser, '[data-action="join-contact"]');
    await poll(
      () =>
        browser.evaluate<boolean>("location.pathname.startsWith('/chats/')"),
      60000,
    );
    await poll(async () => {
      const contact = (await a.app.contacts.list()).find((contact) =>
        contact.displayName === b!.name
      );
      return !!contact?.isKeyContact && contact.e2eeAvail;
    }, 60000);
    await click(browser, 'a[href="/contacts"]');
    // B independently joins the displayed SVG/link as a normal peer scanner.
    await b.core.call((rpc) => rpc.secureJoin(b!.id, invite));
    await poll(() => Promise.resolve(b!.joined.length > 0), 60000);
    // C stays blocked. Joining a link is not an implicit unblock operation.
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.contact-list')?.textContent.includes('Phone fixture')",
      )
    );
    const contacts = await a.app.contacts.list(),
      bid = contacts.find((contact) => contact.displayName === b!.name)!.id,
      paired = contacts.find((contact) => contact.id === bid)!;
    assert(paired.isKeyContact && paired.e2eeAvail);
    assert(
      await browser.evaluate<boolean>(
        `(()=>{const row=document.querySelector('[data-contact-id="${bid}"]');return row?.children[1].textContent==='Yes'&&row.children[2].textContent==='Yes'})()`,
      ),
    );
    record("secureJoinAndLiveCurrentEncryptionLabels", {
      contacts: contacts.length,
      pairedKeyContactAndEncryptionAvailable: true,
    });
    await click(browser, `[data-contact-id="${bid}"] button`);
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.conversation-header h2')?.textContent==='Phone fixture'",
      )
    );
    const chatId = Number(
      (await browser.evaluate<string>("location.pathname")).split("/").at(-1),
    );
    const text = "Sent from the relay desk\nSecond line";
    await type(browser, "#message-draft", "Sent from the relay desk");
    await key(browser, "Enter", 8);
    await browser.send("Input.insertText", { text: "Second line" });
    await key(browser, "Enter");
    const sent = await receive(b, text);
    assertEquals(sent.text, text);
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('#message-draft').value===''",
      )
    );
    await b.core.call((rpc) => rpc.markseenMsgs(b!.id, [sent.id]));
    await poll(
      () =>
        browser.evaluate<boolean>(
          "[...document.querySelectorAll('.message-self')].some(el=>el.textContent.includes('Sent from the relay desk')&&el.dataset.messageState==='read')",
        ),
      60000,
    );
    record("composerDecodedEncryptedAtPeerAndReadState");
    await click(browser, 'a[href="/contacts"]');
    const incoming = "A live reply from your phone";
    const incomingId = await b.core.call((rpc) =>
      rpc.miscSendTextMessage(b!.id, sent.chatId, incoming)
    );
    await poll(
      async () =>
        (await a.app.chats.messages(chatId)).some((message) =>
          message.text === incoming
        ),
      60000,
    );
    const token = await a.app.auth.login(
      "operator",
      "private-m3-browser-password",
    );
    const cookie = a.app.auth.cookie(token!).split(";")[0];
    const inspected = await fetch(
      `http://${lanAddress()}:${port}/api/chats/${chatId}/messages`,
      { headers: { cookie }, signal: AbortSignal.timeout(10000) },
    );
    assertEquals(inspected.status, 200);
    assert(
      (await inspected.json()).messages.some((m: Message) =>
        m.text === incoming
      ),
    );
    assertEquals(
      (await b.core.call((rpc) => rpc.getMessage(b!.id, incomingId))).state,
      26,
    );
    const arrived = Date.now();
    await click(browser, `[data-contact-id="${bid}"] button`);
    await poll(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector('.message-history')?.textContent.includes(${
            JSON.stringify(incoming)
          })`,
        ),
      10000,
    );
    await poll(
      async () =>
        (await b!.core.call((rpc) => rpc.getMessage(b!.id, incomingId)))
          .state === 28,
      60000,
    );
    const live = "Another reply without reloading";
    const began = Date.now();
    await b.core.call((rpc) =>
      rpc.miscSendTextMessage(b!.id, sent.chatId, live)
    );
    await poll(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector('.message-history')?.textContent.includes(${
            JSON.stringify(live)
          })`,
        ),
      10000,
    );
    record("livePeerAndPresentationReceipt", {
      openMs: Date.now() - arrived,
      liveMs: Date.now() - began,
      getInspectionDidNotMark: true,
    });
    client = new Client({ name: "m3-browser-history-consumer", version: "0" });
    await deadline(
      client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://${lanAddress()}:${port}/mcp`),
          {
            requestInit: { headers: { Authorization: `Bearer ${apiKey.key}` } },
          },
        ),
      ),
    );
    const read = await tool<{ messages: Message[] }>(client, "read_messages", {
      chat_id: chatId,
      limit: 100,
    });
    assert(read.messages.some((m) => m.text === incoming));
    record("uiReadStillMcpReadable");
    const attachment = `${root}/B/relay-notes.txt`;
    await Deno.writeTextFile(attachment, "Private fixture attachment body");
    await b.core.sendFile(b.id, sent.chatId, attachment, "relay-notes.txt");
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('.message-history')?.textContent.includes('Attachment: relay-notes.txt')",
        ),
      60000,
    );
    assert(
      await browser.evaluate<boolean>(
        "!document.querySelector('.message-history img, .message-history video, .message-history a[download]')",
      ),
    );
    record("incomingAttachmentNameOnly");
    // Keep TXT's original no-images proof above. Real encrypted raster messages
    // follow it, from a separately owned stock peer, while outside the chat.
    await click(browser, 'a[href="/contacts"]');
    const fixtures = await imageFixtures(browser, `${root}/B`);
    const images: {
      id: number;
      peerId: number;
      caption: string;
      format: string;
      name: string;
    }[] = [];
    for (const format of ["jpeg", "png"]) {
      const caption = `Received ${format.toUpperCase()} landscape`;
      const peerId = await b.core.sendImage(
        b.id,
        sent.chatId,
        fixtures[format],
        `landscape.${format}`,
        caption,
      );
      let received: Message | undefined;
      await poll(async () => {
        received = (await a.app.chats.messages(chatId, { limit: 100 })).find(
          (m) => m.text === caption,
        );
        return !!received?.inlineImage;
      }, 60000);
      assert(received!.encrypted);
      assertEquals(received!.inlineImage!.mimeType, `image/${format}`);
      const response = await fetch(
        `http://${lanAddress()}:${port}/api/messages/${received!.id}/image`,
        { headers: { cookie }, signal: AbortSignal.timeout(10000) },
      );
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("cache-control"), "no-store");
      assertEquals(response.headers.get("content-type"), `image/${format}`);
      assert((await response.arrayBuffer()).byteLength > 0);
      images.push({
        id: received!.id,
        peerId,
        caption,
        format,
        name: received!.attachmentName ?? "Received image",
      });
    }
    await pause(1500);
    for (const image of images) {
      assertEquals(
        (await b.core.call((rpc) => rpc.getMessage(b!.id, image.peerId))).state,
        26,
      );
    }
    record("imageInspectionOutsideChatDeliveredNotRead", images);
    await click(browser, `[data-contact-id="${bid}"] button`);
    for (const image of images) {
      await poll(() =>
        browser.evaluate<boolean>(
          `!!document.querySelector('[data-message-id="${image.id}"] img')?.naturalWidth`,
        )
      );
      await browser.evaluate(
        `document.querySelector('[data-message-id="${image.id}"]').scrollIntoView({block:'center'})`,
      );
      const decoded = await decodedImage(browser, image.id);
      assert(decoded.visible && decoded.bounded && decoded.encrypted);
      assertEquals([decoded.width, decoded.height], [240, 136]);
      assertEquals(decoded.caption, image.caption);
      assertEquals(decoded.src, `/api/messages/${image.id}/image`);
      assertEquals(decoded.alt, image.name);
      assert(
        await browser.evaluate<boolean>(
          `document.querySelector('[data-message-id="${image.id}"] .message-attachment').textContent.includes(${
            JSON.stringify(image.name)
          })`,
        ),
      );
      await poll(
        async () =>
          (await b!.core.call((rpc) => rpc.getMessage(b!.id, image.peerId)))
            .state === 28,
        60000,
      );
      record(
        `encrypted${image.format}ConsumerDecodeAndPresentationRead`,
        decoded,
      );
    }
    await click(browser, `[data-message-id="${images[1].id}"] input`);
    await poll(() =>
      browser.evaluate<boolean>(
        `document.querySelector('[data-message-id="${
          images[1].id
        }"] input')?.checked===true`,
      )
    );
    await click(browser, `[data-message-id="${images[1].id}"] input`);
    await poll(() =>
      browser.evaluate<boolean>(
        `document.querySelector('[data-message-id="${
          images[1].id
        }"] input')?.checked===false`,
      )
    );
    record("receivedImageNativeSelectionPreserved");
    const room = await tool<{ chat_id: number }>(client, "create_room", {
      name: "Agent session room",
      contact_ids: [bid],
    });
    await poll(
      () =>
        browser.evaluate<boolean>(
          `!!document.querySelector('[data-chat-id="${room.chat_id}"]')`,
        ),
      10000,
    );
    record("mcpRoomAppearedLive");
    // Native route transitions retain independent draft revisions.
    await type(browser, "#message-draft", "Draft for the phone");
    await click(browser, `[data-chat-id="${room.chat_id}"]`);
    await type(browser, "#message-draft", "Draft for the room");
    await click(browser, `[data-chat-id="${chatId}"]`);
    assertEquals(
      await browser.evaluate("document.querySelector('#message-draft').value"),
      "Draft for the phone",
    );
    const nav = await browser.send("Page.getNavigationHistory"),
      entries = nav.entries as { id: number }[];
    await browser.send("Page.navigateToHistoryEntry", {
      entryId: entries[(nav.currentIndex as number) - 1].id,
    });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('#message-draft')?.value==='Draft for the room'",
      )
    );
    await browser.send("Page.navigateToHistoryEntry", {
      entryId: entries[nav.currentIndex as number].id,
    });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('#message-draft')?.value==='Draft for the phone'",
      )
    );
    record("perChatDraftsAndNativeBackForward");
    await fill(browser, "#message-draft", "");
    const originalSend = a.app.send.sendText.bind(a.app.send),
      started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    a.app.send.sendText = async (id, value) => {
      started.resolve();
      await release.promise;
      return originalSend(id, value);
    };
    await type(browser, "#message-draft", "In-flight text");
    await click(browser, '[data-action="send-message"]');
    await started.promise;
    await fill(browser, "#message-draft", "New input during send");
    release.resolve();
    await receive(b, "In-flight text");
    await poll(() =>
      browser.evaluate<boolean>(
        "!document.querySelector('[data-action=send-message]').disabled",
      )
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#message-draft').value"),
      "New input during send",
    );
    a.app.send.sendText = originalSend;
    record("lateSendPreservedNewInput");
    // Real core recovery must be visible despite HTTP still answering200.
    await click(browser, 'a[href="/status"]');
    const corePid = a.corePid()!;
    Deno.kill(corePid, "SIGKILL");
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('[data-core-state]')?.textContent==='restarting'",
        ),
      10000,
    );
    assert(
      await browser.evaluate<boolean>(
        "document.querySelector('.status-screen')?.textContent.includes('Unavailable while core restarts') && !document.querySelector('.status-screen')?.textContent.includes('Not configured')",
      ),
    );
    await browser.screenshot(`${evidence}/status-restarting-working.png`);
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('[data-core-state]')?.textContent==='ready'",
        ),
      15000,
    );
    record("actualCoreRecoveryNotHttp200Connected");
    for (const mode of ["light", "dark"]) {
      await theme(browser, mode);
      await browser.screenshot(`${evidence}/status-${mode}-working.png`);
    }
    await click(browser, 'a[href="/chats"]');
    await click(browser, `[data-chat-id="${chatId}"]`);
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.conversation-header h2')?.textContent==='Phone fixture' && !document.querySelector('[data-action=send-message]').disabled",
      )
    );
    await client.close();
    client = undefined;
    await a.close();
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('.connection-status')?.textContent.includes('interrupted')",
        ),
      10000,
    );
    await click(browser, '[data-action="send-message"]');
    await poll(
      () =>
        browser.evaluate<boolean>(
          "!!document.querySelector('.composer-row [role=alert]')",
        ),
      20000,
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#message-draft').value"),
      "New input during send",
    );
    await pause(1200);
    a = await start();
    await poll(
      () =>
        browser.evaluate<boolean>(
          "!document.querySelector('.connection-status')?.textContent.includes('interrupted')",
        ),
      20000,
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#message-draft').value"),
      "New input during send",
    );
    await poll(() =>
      browser.evaluate<boolean>(
        `document.querySelector('.message-history')?.textContent.includes(${
          JSON.stringify(live)
        })`,
      )
    );
    const unique = await browser.evaluate<number[]>(
      "[...document.querySelectorAll('[data-message-id]')].map(el=>Number(el.dataset.messageId))",
    );
    assertEquals(new Set(unique).size, unique.length);
    record("serviceRestartResyncNoDuplicatesDraftRetained");
    for (const image of images) {
      await poll(() =>
        browser.evaluate<boolean>(
          `!!document.querySelector('[data-message-id="${image.id}"] img')?.naturalWidth`,
        )
      );
      assert((await decodedImage(browser, image.id)).width > 0);
    }
    record("imagesReconciledAfterChatSwitchAndServiceReconnect");
    await click(browser, '[data-action="send-message"]');
    await receive(b, "New input during send");
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('#message-draft').value===''",
      )
    );
    // Thirty-message pages use core order, with local deletion visible to MCP.
    for (let i = 0; i < 34; i++) {
      await b.core.call((rpc) =>
        rpc.miscSendTextMessage(b!.id, sent.chatId, `History line ${i + 1}`)
      );
    }
    await poll(
      async () =>
        (await a.app.chats.messages(chatId, { limit: 100 })).some((m) =>
          m.text === "History line 34"
        ),
      60000,
    );
    await poll(
      () =>
        browser.evaluate<boolean>(
          "document.querySelectorAll('[data-message-id]').length===30",
        ),
      10000,
    );
    await click(browser, '[data-action="earlier"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelectorAll('[data-message-id]').length>30",
      )
    );
    await poll(() =>
      browser.evaluate<boolean>(
        `document.querySelector('.message-history')?.textContent.includes(${
          JSON.stringify(incoming)
        })`,
      )
    );
    const target = (await a.app.chats.messages(chatId, { limit: 100 })).find(
      (m) => m.text === "History line 34",
    )!;
    await click(browser, `[data-message-id="${target.id}"] input`);
    await click(browser, '[data-action="ask-delete-messages"]');
    await click(browser, '[data-action="delete-messages"]');
    await poll(() =>
      browser.evaluate<boolean>(
        `!document.querySelector('[data-message-id="${target.id}"]')`,
      )
    );
    assert(
      (await history(b, sent.chatId)).some((m) => m.text === "History line 34"),
    );
    client = new Client({ name: "m3-after-restart", version: "0" });
    await deadline(
      client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://${lanAddress()}:${port}/mcp`),
          {
            requestInit: { headers: { Authorization: `Bearer ${apiKey.key}` } },
          },
        ),
      ),
    );
    const retained = await tool<{ messages: Message[] }>(
      client,
      "read_messages",
      { chat_id: chatId, limit: 100 },
    );
    assert(!retained.messages.some((m) => m.id === target.id));
    assert(retained.messages.some((m) => m.text === incoming));
    record("paginationAndLocalDeleteMcpAndPeer");
    const finalReply =
      "The relay is ready. Your agent can read this conversation.";
    await b.core.call((rpc) =>
      rpc.miscSendTextMessage(b!.id, sent.chatId, finalReply)
    );
    await poll(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector('.message-history')?.textContent.includes(${
            JSON.stringify(finalReply)
          })`,
        ),
      10000,
    );
    const finalSend = "Messages from the browser and agent share this history.";
    await type(browser, "#message-draft", finalSend);
    await click(browser, '[data-action="send-message"]');
    const finalPeer = await receive(b, finalSend);
    await b.core.call((rpc) => rpc.markseenMsgs(b!.id, [finalPeer.id]));
    await poll(
      () =>
        browser.evaluate<boolean>(
          `[...document.querySelectorAll('.message-self')].some(el=>el.textContent.includes(${
            JSON.stringify(finalSend)
          })&&el.dataset.messageState==='read')`,
        ),
      60000,
    );
    record("desktopGeometry", await geometry(browser));
    // Refetch older canonical history, then put actual received images in the
    // final frames rather than handing over a text-only screenshot.
    const showImages = async () => {
      if (
        !await browser.evaluate<boolean>(
          `!!document.querySelector('[data-message-id="${images[0].id}"]')`,
        )
      ) {
        await click(browser, '[data-action="earlier"]');
      }
      await poll(() =>
        browser.evaluate<boolean>(
          `!!document.querySelector('[data-message-id="${
            images[0].id
          }"] img')?.naturalWidth`,
        )
      );
      await browser.evaluate(
        `document.querySelector('[data-message-id="${
          images[0].id
        }"]').scrollIntoView({block:'start'})`,
      );
      await pause(100);
      assert((await decodedImage(browser, images[0].id)).visible);
    };
    await showImages();
    const contactRegions = [
      ".app-header",
      ".nav-rail",
      ".connection-status",
      ".invite-panel",
      ".contact-join",
      ".contact-requests",
      ".contact-list",
      ".app-footer",
    ];
    const chatRegions = [
      ".app-header",
      ".nav-rail",
      ".connection-status",
      ".chat-index-header",
      ".chat-items",
      ".conversation-header",
      ".message-history",
      ".composer-row",
      ".app-footer",
    ];
    for (const mode of ["light", "dark"]) {
      await theme(browser, mode);
      assertEquals(
        await browser.evaluate(
          "getComputedStyle(document.documentElement).backgroundColor",
        ),
        mode === "dark" ? "rgb(34, 38, 44)" : "rgb(255, 255, 255)",
      );
      await fullShot(browser, `${evidence}/chat-${mode}.png`, chatRegions);
      await click(browser, 'a[href="/contacts"]');
      await poll(() =>
        browser.evaluate<boolean>(
          "!!document.querySelector('[data-invite-qr]')",
        )
      );
      assertEquals(
        await browser.evaluate(
          "getComputedStyle(document.querySelector('.invite-qr')).backgroundColor",
        ),
        "rgb(255, 255, 255)",
      );
      assertEquals(
        await browser.evaluate(
          "decodeURIComponent(document.querySelector('[data-invite-qr]').src.split(',').slice(1).join(','))",
        ),
        svg,
      );
      await fullShot(
        browser,
        `${evidence}/contacts-${mode}.png`,
        contactRegions,
      );
      await click(browser, `[data-contact-id="${bid}"] button`);
      await poll(() =>
        browser.evaluate<boolean>(
          "!!document.querySelector('.message-history')",
        )
      );
      await showImages();
    }
    record("fullContactsChatBothThemesCoreQrQuietZone");
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause(100);
    assert(
      await browser.evaluate<boolean>(
        "document.documentElement.scrollWidth<=innerWidth && getComputedStyle(document.querySelector('.chat-index')).display==='none' && !!document.querySelector('.chat-back')",
      ),
    );
    const mobile = await browser.evaluate<{ bottom: number; top: number }>(
      "({bottom:document.querySelector('.message-history').getBoundingClientRect().bottom,top:document.querySelector('.composer-row').getBoundingClientRect().top})",
    );
    assert(Math.abs(mobile.bottom - mobile.top) < .5);
    await browser.screenshot(`${evidence}/chat-narrow-working.png`);
    await browser.evaluate(
      `document.querySelector('[data-message-id="${
        images[0].id
      }"]').scrollIntoView({block:'start'})`,
    );
    for (const mode of ["light", "dark"]) {
      await theme(browser, mode);
      assert((await decodedImage(browser, images[0].id)).bounded);
      await fullShot(browser, `${evidence}/chat-images-narrow-${mode}.png`, [
        ".app-header",
        ".nav-rail",
        ".connection-status",
        ".conversation-header",
        ".message-history",
        ".composer-row",
        ".app-footer",
      ]);
    }
    await click(browser, ".chat-back");
    await poll(() =>
      browser.evaluate<boolean>(
        "location.pathname==='/chats' && getComputedStyle(document.querySelector('.chat-index')).display!=='none'",
      )
    );
    record("narrow390ContainedComposer", mobile);
    // Explicit successful sends remove drafts before a deep-link reload.
    await click(browser, `[data-chat-id="${room.chat_id}"]`);
    await fill(browser, "#message-draft", "");
    await click(browser, 'a[href="/chats"]');
    await browser.send("Page.navigate", {
      url: `${origin}/chats?chat=${chatId}`,
    });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.conversation-header h2')?.textContent==='Phone fixture'",
      )
    );
    await browser.evaluate("window.__beforeImageReload=true");
    await browser.send("Page.reload");
    await poll(() =>
      browser.evaluate<boolean>(
        "window.__beforeImageReload!==true && document.querySelector('.conversation-header h2')?.textContent==='Phone fixture' && document.querySelectorAll('[data-message-id]').length===30",
      )
    );
    record("queryDeepLinkAndReload");
    await showImages();
    record(
      "receivedImageDecodesAfterDocumentReload",
      await decodedImage(browser, images[0].id),
    );
    await a.app.delete.deleteMessages([images[0].id]);
    const deletedImage = await fetch(
      `http://${lanAddress()}:${port}/api/messages/${images[0].id}/image`,
      { headers: { cookie }, signal: AbortSignal.timeout(10000) },
    );
    assertEquals(deletedImage.status, 404);
    await deletedImage.body?.cancel();
    assert(
      (await history(b, sent.chatId)).some((m) => m.id === images[0].peerId),
    );
    record("deletedImageNoLongerServedPeerRetainsOriginal");
    await browser.send("Page.navigate", {
      url: `${origin}/chats?chat=invalid`,
    });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.body.textContent.includes('Invalid conversation link') && !document.querySelector('#message-draft')",
      )
    );
    const badHistory = await browser.send("Page.getNavigationHistory"),
      badEntries = badHistory.entries as { id: number }[];
    await browser.send("Page.navigateToHistoryEntry", {
      entryId: badEntries[(badHistory.currentIndex as number) - 1].id,
    });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.conversation-header h2')?.textContent==='Phone fixture'",
      )
    );
    record("invalidQueryAndNativeRecovery");
    await click(browser, '[data-action="logout"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('h1')?.textContent==='Open your relay'",
      )
    );
    await poll(() => Promise.resolve(a.app.streams!.size === 0));
    record("logoutReleasedStream");
    assertEquals(browser.errors, []);
    await Deno.writeTextFile(
      `${evidence}/consumer-proof.json`,
      JSON.stringify(facts, null, 2),
    );
    console.log(JSON.stringify(facts));
  } catch (error) {
    if (page) {
      await page.screenshot(`${evidence}/failure-working.png`);
      await Deno.writeTextFile(
        `${evidence}/failure-observation.json`,
        JSON.stringify(
          {
            facts,
            body: await page.evaluate("document.body.innerText"),
            errors: page.errors,
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    await client?.close();
    await page?.close();
    await a.close();
    await b?.core.close();
    await c?.core.close();
  }
});
