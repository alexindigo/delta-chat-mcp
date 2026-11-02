// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { click, key, productBuild, type } from "./browser.ts";
import {
  deadline,
  evidenceDirectory,
  fixture,
  lanAddress,
  poll,
} from "./support.ts";
import { startService } from "../src/service.ts";
import { loadRuntimeConfig } from "../src/auth/state.ts";
import { createLog } from "../src/log.ts";
import { RoomSetupError } from "../src/messaging/room-outcome.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const activeRoom = (page: Cdp) =>
  poll(() =>
    page.evaluate<boolean>(
      "!!document.querySelector('.room-dialog:modal') && !document.querySelector('.room-members').textContent.includes('Refreshing contacts')",
    )
  );

async function shot(page: Cdp, evidence: string, name: string) {
  const frame = await page.send("Page.captureScreenshot", { format: "png" });
  const data = frame.data as string;
  await Deno.writeFile(
    `${evidence}/${name}.png`,
    Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
  );
  // Crop the SAME captured bitmap. CDP clip recaptures can recompose native
  // top-layer dialogs, so they are not faithful crops of a viewport frame.
  const regions = await page.evaluate<{ label: string; data: string }[]>(
    `(async()=>{
    const image=new Image();image.src=${
      JSON.stringify("data:image/png;base64,")
    }+${JSON.stringify(data)};await image.decode();
    const selectors=['.app-header','.nav-rail','.chats-heading','.chat-index-header','.conversation-header','.app-footer','.room-dialog h2','#room-help','#room-name','.room-members','.room-dialog [role=alert]','.room-dialog [data-room-recovery]','.room-dialog .actions'];
    return selectors.flatMap((s,i)=>[...document.querySelectorAll(s)].flatMap((e,j)=>{
      const r=e.getBoundingClientRect(),x=Math.floor(Math.max(0,r.x)),y=Math.floor(Math.max(0,r.y)),width=Math.ceil(Math.min(innerWidth,r.right))-x,height=Math.ceil(Math.min(innerHeight,r.bottom))-y;
      if(width<=0||height<=0)return [];const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(image,-x,-y);
      return [{label:i+'-'+j,data:canvas.toDataURL('image/png').split(',')[1]}];
    }));
  })()`,
  );
  for (const { label, data } of regions) {
    await Deno.writeFile(
      `${evidence}/review-${name}-${label}.png`,
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    );
  }
}

Deno.test("native room form retains drafts/recovery/history, checkbox geometry, key priority and logout epochs on insecure HTTP", async () => {
  await productBuild();
  const root = await fixture("rooms-browser"),
    evidence = await evidenceDirectory("artifacts", "rooms-browser-");
  const service = await startService(
    loadRuntimeConfig({ DCMCP_DATA_DIR: root, DCMCP_LISTEN_PORT: "0" }).cfg,
    { log: createLog("error", [], () => {}) },
  );
  const contacts = [42, 43, 44].map((id) => ({
    id,
    displayName: `Private peer ${id}`,
    address: `peer${id}@fixture.test`,
    isBlocked: false,
    isKeyContact: true,
    e2eeAvail: id !== 44,
  }));
  service.app.account.status = () =>
    Promise.resolve({
      configured: true,
      accountId: 1,
      address: "fixture@relay.test",
      displayName: "Room fixture",
      connectivity: 4000,
    });
  service.app.account.invitation = () =>
    Promise.resolve({ link: "https://i.delta.chat/#fixture", svg: "<svg/>" });
  service.app.contacts.list = () => Promise.resolve(contacts);
  service.app.chats.list = () =>
    Promise.resolve([{
      id: 99,
      name: "Canonical room",
      type: "Group",
      isEncrypted: true,
      isContactRequest: false,
      freshMessageCount: 0,
      lastMessageId: null,
      lastMessageTime: null,
      contactIds: [1, 42, 43],
      summary: "",
    }]);
  let unpromoted = true;
  service.app.chats.get = () =>
    Promise.resolve({
      id: 99,
      name: "Canonical room",
      type: "Group",
      isEncrypted: true,
      isContactRequest: false,
      freshMessageCount: 0,
      contactIds: [1, 42, 43],
      canSend: true,
      isUnpromoted: unpromoted,
      selfInGroup: true,
    });
  service.app.chats.messages = () => Promise.resolve([]);
  let creates = 0, completes = 0;
  service.app.rooms.createRoom = () => {
    creates++;
    return Promise.reject(
      new RoomSetupError({
        kind: "incomplete",
        chatId: 99,
        intendedContactIds: [42, 43],
        missingContactIds: [43],
        completionStopped: false,
        message: "Room 99 exists. Retry adding contacts to this same room.",
      }),
    );
  };
  service.app.rooms.completeRoom = (id, ids) => {
    completes++;
    assertEquals(id, 99);
    assertEquals(ids, [42, 43]);
    return Promise.resolve({ chatId: id });
  };
  let page: Cdp | undefined, releaseKey = () => {}, releaseRoom = () => {};
  try {
    await service.app.auth.setup({
      type: "password",
      username: "operator",
      password: "private-room-browser-fixture",
    });
    page = await Cdp.launch(
      await fixture("rooms-browser-profile"),
      lanAddress(),
      evidence,
    );
    const browser = page,
      origin = `http://delta-chat-mcp.test:${service.addr.port}`;
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.send("Page.navigate", { url: origin + "/chats" });
    await type(browser, "#username", "operator");
    await type(browser, "#password", "private-room-browser-fixture");
    await click(browser, '[data-action="access-submit"]');
    console.log({ time: new Date().toISOString(), roomPhase: "open form" });
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    assertEquals(await browser.evaluate("isSecureContext"), false);
    assertEquals(
      await browser.evaluate("location.hostname"),
      "delta-chat-mcp.test",
    );
    await click(browser, '[data-action="create-room"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.room-dialog [role=alert]')?.textContent.includes('Enter a room name')",
      )
    );
    assertEquals(creates, 0);
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-room-count]').textContent",
      ),
      "Only this identity",
    );
    await type(browser, "#room-name", "Browser room draft");
    await click(browser, '[data-room-contact="42"] input');
    await click(browser, '[data-room-contact="43"] input');
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-room-count]').textContent",
      ),
      "2 selected",
    );
    assert(
      await browser.evaluate<boolean>(
        "document.querySelector('[data-room-contact=\"44\"] input').disabled && document.querySelector('[data-room-contact=\"44\"]').textContent.includes('Encryption unavailable')",
      ),
    );
    await click(browser, "#room-name");
    await key(browser, "Tab", 8);
    assertEquals(
      await browser.evaluate("document.activeElement.dataset.action"),
      "discard-room",
    );
    await key(browser, "Tab");
    assertEquals(
      await browser.evaluate("document.activeElement.id"),
      "room-name",
    );
    await key(browser, "Tab");
    assertEquals(
      await browser.evaluate(
        "document.activeElement.closest('[data-room-contact]').dataset.roomContact",
      ),
      "42",
    );
    for (let i = 0; i < 10; i++) {
      await key(browser, "Tab");
      assert(
        await browser.evaluate<boolean>(
          "!!document.activeElement.closest('dialog:modal')",
        ),
      );
    }
    const measure = async () => {
      const facts = await browser.evaluate<
        {
          square: number[];
          centers: number;
          modalFits: boolean;
          overflow: boolean;
          actionsAligned: number;
          visibleCtas: number;
        }
      >(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),c=r('[data-room-contact="42"] input'),t=r('[data-room-contact="42"] .room-contact-text'),d=r('.room-dialog'),a=r('.conversation-actions h2'),b=r('.conversation-actions button');return {square:[c.width,c.height],centers:(c.top+c.height/2)-(t.top+t.height/2),modalFits:d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,actionsAligned:(a.top+a.height/2)-(b.top+b.height/2),visibleCtas:[...document.querySelectorAll('[data-action="new-room"]')].filter(e=>e.getClientRects().length).length}})()`);
      assertEquals(facts.square, [18, 18]);
      assert(Math.abs(facts.centers) < .5);
      assert(facts.modalFits);
      assert(!facts.overflow);
      assertEquals(facts.visibleCtas, 1);
      if (await browser.evaluate<boolean>("innerWidth>700")) {
        assert(Math.abs(facts.actionsAligned) < .5);
      }
      return facts;
    };
    const desktop = await measure();
    console.log({
      time: new Date().toISOString(),
      roomPhase: "desktop geometry",
      desktop,
    });
    await shot(browser, evidence, "room-desktop-light");
    await key(browser, "Escape");
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await click(browser, '[data-action="open-theme"]');
    await click(browser, '[data-theme-id="system"]');
    await click(browser, '[data-action="theme-done"]');
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    assertEquals(
      await browser.evaluate("document.querySelector('#room-name').value"),
      "Browser room draft",
    );
    await shot(browser, evidence, "room-desktop-dark");
    await key(browser, "Escape");
    await click(browser, '[data-action="open-theme"]');
    await click(browser, '[data-theme-id="nord"]');
    await click(browser, '[data-action="theme-done"]');
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    await shot(browser, evidence, "room-desktop-nord");
    await click(browser, '[data-action="create-room"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-room-recovery]')",
      )
    );
    assertEquals(creates, 1);
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-action=create-room]').disabled",
      ),
      true,
    );
    await shot(browser, evidence, "room-partial-recovery");
    await key(browser, "Escape");
    await click(browser, 'a[href="/keys"]');
    const nav = await browser.send("Page.getNavigationHistory"),
      entries = nav.entries as { id: number }[];
    await browser.send("Page.navigateToHistoryEntry", {
      entryId: entries[(nav.currentIndex as number) - 1].id,
    });
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    assertEquals(
      await browser.evaluate("document.querySelector('#room-name').value"),
      "Browser room draft",
    );
    await click(browser, '[data-action="complete-room"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "location.pathname==='/chats/99' && document.querySelector('.conversation-header h2')?.textContent==='Canonical room'",
      )
    );
    assertEquals(creates, 1);
    assertEquals(completes, 1);
    console.log({
      time: new Date().toISOString(),
      roomPhase: "same-ID complete",
    });
    assert(
      await browser.evaluate<boolean>(
        "!!document.querySelector('[data-room-first-message]')",
      ),
    );
    unpromoted = false;
    service.app.events.emit({ type: "chats" });
    await poll(() =>
      browser.evaluate<boolean>(
        "!document.querySelector('[data-room-first-message]')",
      )
    );
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await click(browser, '.narrow-room-entry [data-action="new-room"]');
    await activeRoom(browser);
    await type(browser, "#room-name", "Narrow room draft");
    await click(browser, '[data-room-contact="42"] input');
    const narrow = await measure();
    console.log({
      time: new Date().toISOString(),
      roomPhase: "narrow geometry",
      narrow,
    });
    await shot(browser, evidence, "room-narrow-dark");
    await key(browser, "Escape");
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await click(browser, '[data-action="open-theme"]');
    await click(browser, '[data-theme-id="system"]');
    await click(browser, '[data-action="theme-done"]');
    await click(browser, '.narrow-room-entry [data-action="new-room"]');
    await activeRoom(browser);
    await measure();
    await shot(browser, evidence, "room-narrow-light");
    // A late shown-once key suspends the room, with only one actual top-layer modal.
    await key(browser, "Escape");
    await click(browser, 'a[href="/keys"]');
    const originalKey = service.app.apiKeys.create.bind(service.app.apiKeys),
      keyStarted = Promise.withResolvers<void>(),
      keyRelease = Promise.withResolvers<void>();
    releaseKey = () => keyRelease.resolve();
    service.app.apiKeys.create = async (name) => {
      const value = await originalKey(name);
      keyStarted.resolve();
      await keyRelease.promise;
      return value;
    };
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('#key-name') && !document.querySelector('#key-name').disabled",
      )
    );
    await type(browser, "#key-name", "Late private fixture");
    await click(browser, '[data-action="create-key"]');
    console.log({
      time: new Date().toISOString(),
      roomPhase: "late key requested",
      native: await browser.evaluate(
        "({path:location.pathname,name:document.querySelector('#key-name')?.value,button:document.querySelector('[data-action=create-key]')?.outerHTML,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)})",
      ),
    });
    await deadline(keyStarted.promise, 5000);
    await click(browser, 'a[href="/chats"]');
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    releaseKey();
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('.key-handoff:modal') && !document.querySelector('.room-dialog')",
      )
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('dialog:modal').length",
      ),
      1,
    );
    await key(browser, "Escape");
    assert(
      await browser.evaluate<boolean>(
        "!!document.querySelector('.key-handoff:modal')",
      ),
    );
    await click(browser, '[data-action="copy-key"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.key-handoff [role=status]')?.textContent==='Key copied.'",
      )
    );
    assert(
      await browser.evaluate<boolean>(
        "!!document.activeElement.closest('.key-handoff:modal')",
      ),
    );
    await click(browser, '[data-action="dismiss-key"]');
    await activeRoom(browser);
    assertEquals(
      await browser.evaluate("document.querySelector('#room-name').value"),
      "Narrow room draft",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-room-contact=\"42\"] input').checked",
      ),
      true,
    );
    // A second delayed shown-once response suspends Theme, preserving choice and
    // roving focus independently of the retained room draft. Copy stays modal.
    await key(browser, "Escape");
    await click(browser, 'a[href="/keys"]');
    const themeKeyStarted = Promise.withResolvers<void>(),
      themeKeyRelease = Promise.withResolvers<void>();
    releaseKey = () => themeKeyRelease.resolve();
    service.app.apiKeys.create = async (name) => {
      const value = await originalKey(name);
      themeKeyStarted.resolve();
      await themeKeyRelease.promise;
      return value;
    };
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('#key-name') && !document.querySelector('#key-name').disabled",
      )
    );
    await type(browser, "#key-name", "Theme priority fixture");
    await click(browser, '[data-action="create-key"]');
    await deadline(themeKeyStarted.promise, 5000);
    await click(browser, '[data-action="open-theme"]');
    await click(browser, '[data-theme-id="dracula-alucard"]');
    await key(browser, "End");
    await poll(() =>
      browser.evaluate<boolean>(
        "document.activeElement?.dataset.themeId==='nord'",
      )
    );
    releaseKey();
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('.key-handoff:modal') && !document.querySelector('.theme-dialog') && document.querySelectorAll('dialog:modal').length===1",
      )
    );
    assert(
      await browser.evaluate<boolean>(
        "document.querySelector('[data-action=open-theme]').disabled",
      ),
    );
    const themeSecret = await browser.evaluate<string>(
      "document.querySelector('[data-once-key]').textContent",
    );
    await key(browser, "Escape");
    await click(browser, '[data-action="copy-key"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('.key-handoff [role=status]')?.textContent==='Key copied.'",
      )
    );
    assert(
      await browser.evaluate<boolean>(
        "!!document.activeElement.closest('.key-handoff:modal')",
      ),
    );
    await click(browser, '[data-action="dismiss-key"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('.theme-dialog:modal') && document.activeElement?.dataset.themeId==='nord'",
      )
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[role=radio][aria-checked=true]').dataset.themeId",
      ),
      "dracula-alucard",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('dialog:modal').length",
      ),
      1,
    );
    await key(browser, "Escape");
    // Native paste of the key copied while Theme was suspended. No fixture key
    // bytes are written to logs/screenshots.
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('#key-name') && !document.querySelector('#key-name').disabled",
      )
    );
    await click(browser, "#key-name");
    await key(browser, "a", 2);
    await key(browser, "v", 2);
    await poll(() =>
      browser.evaluate<boolean>(
        `document.querySelector('#key-name').value===${
          JSON.stringify(themeSecret)
        }`,
      )
    );
    await key(browser, "a", 2);
    await key(browser, "Backspace");
    await click(browser, 'a[href="/chats"]');
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    assertEquals(
      await browser.evaluate("document.querySelector('#room-name').value"),
      "Narrow room draft",
    );
    const reloading = browser.send("Page.reload");
    await pause(200);
    await browser.send("Page.handleJavaScriptDialog", { accept: false });
    await reloading;
    assertEquals(
      await browser.evaluate("document.querySelector('#room-name').value"),
      "Narrow room draft",
    );
    await key(browser, "Escape");
    await click(browser, '[data-action="logout"]');
    await click(browser, '[data-action="keep-work"]');
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    assertEquals(
      await browser.evaluate("document.querySelector('#room-name').value"),
      "Narrow room draft",
    );
    await click(browser, '[data-action="discard-room"]');
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    await type(browser, "#room-name", "Unknown acknowledgement");
    service.app.rooms.createRoom = () => {
      creates++;
      return Promise.reject(
        new RoomSetupError({
          kind: "uncertain",
          message: "A room may exist. Inspect Conversations.",
        }),
      );
    };
    await click(browser, '[data-action="create-room"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-action=another-room]')",
      )
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-action=create-room]').disabled",
      ),
      true,
    );
    await shot(browser, evidence, "room-uncertain");
    await key(browser, "Escape");
    await click(browser, '.chat-index-header [data-action="new-room"]');
    await activeRoom(browser);
    assertEquals(
      await browser.evaluate("document.querySelector('#room-name').value"),
      "Unknown acknowledgement",
    );
    await click(browser, '[data-action="another-room"]');
    const roomStarted = Promise.withResolvers<void>(),
      roomRelease = Promise.withResolvers<void>();
    releaseRoom = () => roomRelease.resolve();
    service.app.rooms.createRoom = async () => {
      creates++;
      roomStarted.resolve();
      await roomRelease.promise;
      return { chatId: 99 };
    };
    await click(browser, '[data-action="create-room"]');
    await deadline(roomStarted.promise, 5000);
    await key(browser, "Escape");
    await click(browser, '[data-action="logout"]');
    await click(browser, '[data-action="discard-logout"]');
    await poll(() =>
      browser.evaluate<boolean>("!!document.querySelector('#password')")
    );
    releaseRoom();
    await pause(100);
    assert(
      await browser.evaluate<boolean>(
        "!document.querySelector('dialog') && !!document.querySelector('#password')",
      ),
    );
    assertEquals(browser.errors, []);
    console.log({
      evidence,
      desktop,
      narrow,
      sameIdCompletionNoNewCreate: true,
      keyPriorityAndRoomRestored: true,
      keyPriorityAndThemeFocusChoiceRestored: true,
      copiedWhileThemeSuspendedNativePaste: true,
      unknownNoBlindRetry: true,
      dirtyNativeDepartureAndLogout: true,
      lateLogoutCannotNavigate: true,
    });
  } catch (error) {
    if (page) {
      await Deno.writeTextFile(
        `${evidence}/failure.json`,
        JSON.stringify(
          await page.evaluate(
            "({room:document.querySelector('.room-dialog')?.outerHTML,modals:[...document.querySelectorAll('dialog:modal')].map(e=>e.className),focus:{tag:document.activeElement?.tagName,action:document.activeElement?.dataset.action,theme:document.activeElement?.dataset.themeId},themeRadios:[...document.querySelectorAll('.theme-dialog [role=radio]')].map(e=>({id:e.dataset.themeId,tab:e.tabIndex,checked:e.getAttribute('aria-checked')})),alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),errors:[]})",
          ),
          null,
          2,
        ),
      );
      await page.screenshot(`${evidence}/failure-working.png`);
      console.log({
        evidence,
        originalFailure: error instanceof Error ? error.stack : String(error),
        errors: page.errors,
      });
    }
    throw error;
  } finally {
    releaseKey();
    releaseRoom();
    await page?.close();
    await service.close();
  }
});
