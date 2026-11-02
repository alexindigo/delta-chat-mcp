// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { startService } from "../src/service.ts";
import { loadRuntimeConfig } from "../src/auth/state.ts";
import { createLog } from "../src/log.ts";
import { AttachmentsService } from "../src/messaging/attachments.ts";
import type { CoreMessage } from "../src/core/client.ts";
import { toMessage } from "../src/messaging/message.ts";
import { FakeCore } from "./unit/fake_core.ts";
import { Cdp } from "./cdp.ts";
import { click, productBuild } from "./browser.ts";
import { decodedImage, imageFixtures } from "./image_fixtures.ts";
import { evidenceDirectory, fixture, lanAddress, poll } from "./support.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
Deno.test("native media consumer decodes four rasters, keeps named failures, bounds retries and anchors above/below/paging/delayed decode", async () => {
  await productBuild();
  const root = await fixture("web-images");
  const evidence = await evidenceDirectory("artifacts/images", "consumer-");
  const service = await startService(
    loadRuntimeConfig({
      DCMCP_DATA_DIR: `${root}/service`,
      DCMCP_LISTEN_PORT: "0",
      DCMCP_AUTH_TYPE: "public",
    }).cfg,
    { log: createLog("error", [], () => {}) },
  );
  let page: Cdp | undefined;
  const gates = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const requests = new Map<number, number>();
  try {
    page = await Cdp.launch(
      await fixture("web-images-browser"),
      lanAddress(),
      evidence,
    );
    const browser = page;
    const files = await imageFixtures(browser, root);
    const accounts = `${root}/accounts`, blobs = `${accounts}/core-root`;
    await Deno.mkdir(blobs, { recursive: true });
    for (const [format, path] of Object.entries(files)) {
      await Deno.copyFile(path, `${blobs}/${format}`);
    }
    await Deno.writeFile(
      `${blobs}/broken`,
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    );
    const messages: CoreMessage[] = Array.from({ length: 70 }, (_, i) => ({
      id: i + 10,
      chatId: 20,
      fromId: 9,
      state: 16,
      text: `History ${i + 10}: stable reader line`,
      timestamp: 1700000000 + i,
      file: null,
      fileName: null,
      fileMime: null,
      viewType: "Text",
      downloadState: "Done",
      showPadlock: true,
    } as CoreMessage));
    const setImage = (id: number, format: string, dimensions = true) => {
      Object.assign(messages.find((m) => m.id === id)!, {
        viewType: format === "gif" ? "Gif" : "Image",
        file: `${blobs}/${format}`,
        fileName: `${format}-landscape.${format}`,
        fileMime: `image/${format}`,
        dimensionsWidth: dimensions ? (format === "gif" ? 1 : 240) : 0,
        dimensionsHeight: dimensions ? (format === "gif" ? 1 : 136) : 0,
      });
    };
    setImage(20, "png", false);
    setImage(70, "png", false);
    gates.set(20, Promise.withResolvers<void>());
    gates.set(70, Promise.withResolvers<void>());
    setImage(60, "jpeg");
    setImage(61, "webp");
    setImage(62, "gif");
    setImage(63, "png");
    gates.set(63, Promise.withResolvers<void>());
    setImage(64, "png");
    Object.assign(messages.find((m) => m.id === 64)!, {
      file: `${blobs}/broken`,
      fileName: "broken.png",
    });
    Object.assign(messages.find((m) => m.id === 65)!, {
      viewType: "File",
      fileName: "unsupported.svg",
      fileMime: "image/svg+xml",
    });
    for (
      const [i, state] of [
        "Available",
        "InProgress",
        "Failure",
        "Undecipherable",
      ].entries()
    ) {
      Object.assign(messages.find((m) => m.id === 66 + i)!, {
        downloadState: state,
        text: `${state} attachment`,
        fileName: null,
      });
    }
    const core = new FakeCore({
      getMessages: (_account, ids) =>
        Promise.resolve(Object.fromEntries(ids.flatMap((id) => {
          const m = messages.find((m) => m.id === id);
          return m ? [[id, { ...m, kind: "message" }]] : [];
        }))),
      getExistingMsgIds: () => Promise.resolve([]),
      getBlobDir: () => Promise.resolve(blobs),
    });
    const attachments = new AttachmentsService(core, {
      id: () => Promise.resolve(7),
    }, accounts);
    service.app.attachments.openImage = async (id, signal) => {
      requests.set(id, (requests.get(id) ?? 0) + 1);
      await gates.get(id)?.promise;
      return attachments.openImage(id, signal);
    };
    service.app.account.status = () =>
      Promise.resolve({
        configured: true,
        accountId: 7,
        address: "fixture@relay.test",
        displayName: "Private fixture",
        connectivity: 4000,
      });
    service.app.account.invitation = () =>
      Promise.resolve({
        link: "https://i.delta.chat/#fixture",
        svg: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      });
    service.app.contacts.list = () =>
      Promise.resolve([{
        id: 9,
        address: "peer@relay.test",
        displayName: "Phone fixture",
        isBlocked: false,
        isKeyContact: true,
        e2eeAvail: true,
      }]);
    const chat = {
      id: 20,
      name: "Phone fixture",
      type: "Single" as const,
      isEncrypted: true,
      isContactRequest: false,
      freshMessageCount: 0,
      contactIds: [9],
      canSend: true,
      isUnpromoted: false,
      selfInGroup: true,
    };
    const second = messages.slice(0, 60).map((m, i) => ({
      ...m,
      id: 500 + i,
      chatId: 21,
      file: null,
      fileName: null,
      viewType: "Text" as const,
    }));
    service.app.chats.get = (id) => Promise.resolve({ ...chat, id });
    service.app.chats.list = () =>
      Promise.resolve([{
        ...chat,
        lastMessageId: 79,
        lastMessageTime: 1700000070,
        summary: "Raster proof",
      }, {
        ...chat,
        id: 21,
        name: "Second fixture",
        lastMessageId: 559,
        lastMessageTime: 1700000070,
        summary: "Second history",
      }]);
    service.app.chats.messages = (id, range = {}) =>
      Promise.resolve(
        (id === 21 ? second : messages).filter((m) =>
          !range.beforeId || m.id < range.beforeId
        ).slice(
          -(range.limit ?? 30),
        ).map(toMessage),
      );
    service.app.chats.markPresented = () => Promise.resolve();
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.send("Page.navigate", {
      url: `http://delta-chat-mcp.test:${service.addr.port}/chats/20`,
    });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelectorAll('[data-message-id]').length===30",
      )
    );
    assertEquals(await browser.evaluate("isSecureContext"), false);
    const reserved = await browser.evaluate<
      { width: number; height: number; natural: number }
    >("(()=>{const i=document.querySelector('[data-message-id=\"63\"] img'),r=i.getBoundingClientRect();return {width:r.width,height:r.height,natural:i.naturalWidth}})()");
    assertEquals(reserved.natural, 0);
    assertEquals(
      [reserved.width, reserved.height],
      [240, 136],
      "Valid core dimensions reserve geometry before delivery",
    );
    gates.get(63)!.resolve();
    const decodes = [];
    for (const id of [60, 61, 62, 63]) {
      await poll(() =>
        browser.evaluate<boolean>(
          `!!document.querySelector('[data-message-id="${id}"] img')?.naturalWidth`,
        )
      );
      await browser.evaluate(
        `document.querySelector('[data-message-id="${id}"]').scrollIntoView({block:'center'})`,
      );
      const decoded = await decodedImage(browser, id);
      decodes.push({ id, ...decoded });
      assert(
        decoded.width > 0 && decoded.height > 0 && decoded.visible &&
          decoded.bounded,
        JSON.stringify({ id, decoded }),
      );
    }
    for (const id of [65, 66, 67, 68, 69]) {
      assertEquals(
        await browser.evaluate(
          `!!document.querySelector('[data-message-id="${id}"] img')`,
        ),
        false,
      );
    }
    for (
      const text of [
        "Attachment: unsupported.svg",
        "Attachment not downloaded.",
        "Attachment downloading…",
        "Attachment download failed.",
        "Attachment could not be decrypted.",
      ]
    ) {
      assert(
        await browser.evaluate<boolean>(
          `document.querySelector('.message-history').textContent.includes(${
            JSON.stringify(text)
          })`,
        ),
      );
    }
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"64\"] .image-retry')",
      )
    );
    await pause(250);
    assertEquals(requests.get(64), 1);
    for (let n = 0; n < 2; n++) {
      await click(browser, '[data-message-id="64"] .image-retry');
      await poll(() => (requests.get(64) ?? 0) === n + 2);
      await poll(() =>
        browser.evaluate<boolean>(
          `!!document.querySelector('[data-message-id="64"] .message-media-status')`,
        )
      );
    }
    assertEquals(requests.get(64), 3);
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector('[data-message-id=\"64\"] .image-retry')",
      ),
      false,
    );
    const anchor = async (id: number) => {
      await browser.evaluate(
        `document.querySelector('[data-message-id="${id}"]').scrollIntoView({block:'start'})`,
      );
      await pause(100);
      return await position(id);
    };
    const position = (id: number) =>
      browser.evaluate<number>(
        `document.querySelector('[data-message-id="${id}"]').getBoundingClientRect().top-document.querySelector('.message-history').getBoundingClientRect().top`,
      );
    const beforeBelow = await anchor(55);
    gates.get(70)!.resolve();
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"70\"] img')?.naturalWidth",
      )
    );
    await pause(100);
    const afterBelow = await position(55);
    assert(
      Math.abs(beforeBelow - afterBelow) < 1,
      `below growth moved reader ${beforeBelow} -> ${afterBelow}`,
    );
    // Clicking earlier necessarily scrolls the button into view. Snapshot that
    // visible message immediately before dispatch, not a previous reader position.
    await browser.evaluate(
      "scrollTo(0,0);document.querySelector('.message-history').scrollTop=0",
    );
    await pause(100);
    const beforePaging = await position(50);
    const point = await browser.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('[data-action=earlier]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
    }
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelectorAll('[data-message-id]').length===60",
      )
    );
    await pause(100);
    const afterPaging = await position(50);
    assert(
      Math.abs(beforePaging - afterPaging) < 1,
      `paging moved anchor ${beforePaging} -> ${afterPaging}`,
    );
    const beforeAbove = await anchor(55);
    gates.get(20)!.resolve();
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"20\"] img')?.naturalWidth",
      )
    );
    await pause(100);
    const afterAbove = await position(55);
    assert(
      Math.abs(beforeAbove - afterAbove) < 1,
      `above growth moved reader ${beforeAbove} -> ${afterAbove}`,
    );
    // Append below a reader through canonical invalidation, then follow a late
    // decode from the bottom. The test observes consumer geometry at both ends.
    const beforeAppend = await position(55);
    messages.push({
      ...messages.at(-1)!,
      id: 80,
      text: "Appended below the reader",
    });
    service.app.events.emit({ type: "messages", chatId: 20, ids: [80] });
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"80\"]')",
      )
    );
    await pause(100);
    assert(Math.abs(beforeAppend - await position(55)) < 1);
    await browser.evaluate(
      "document.querySelector('.message-history').scrollTop=1e8",
    );
    await pause(100);
    messages.push({
      ...messages.find((m) => m.id === 20)!,
      id: 81,
      text: "Delayed bottom image",
    });
    gates.set(81, Promise.withResolvers<void>());
    service.app.events.emit({ type: "messages", chatId: 20, ids: [81] });
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"81\"] img')",
      )
    );
    gates.get(81)!.resolve();
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"81\"] img')?.naturalWidth",
      )
    );
    await pause(150);
    const bottomGap = await browser.evaluate<number>(
      "(()=>{const h=document.querySelector('.message-history');return h.scrollHeight-h.scrollTop-h.clientHeight})()",
    );
    assert(bottomGap < 1);
    await anchor(55);
    await click(browser, '[data-chat-id="21"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"559\"]')",
      )
    );
    await pause(100);
    const switchGap = await browser.evaluate<number>(
      "(()=>{const h=document.querySelector('.message-history');return h.scrollHeight-h.scrollTop-h.clientHeight})()",
    );
    assert(
      switchGap < 1,
      `New conversation must follow its bottom, gap=${switchGap}`,
    );
    await click(browser, '[data-chat-id="20"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-message-id=\"81\"] img')?.naturalWidth",
      )
    );
    assert((await decodedImage(browser, 81)).visible);
    const imageRequestsBeforeRefresh = requests.get(81);
    await browser.evaluate(
      "window.__retainedArticle=document.querySelector('[data-message-id=\"81\"]');window.__retainedImage=window.__retainedArticle.querySelector('img')",
    );
    messages.find((message) => message.id === 81)!.text =
      "Updated caption for same received image";
    service.app.events.emit({ type: "messages", chatId: 20, ids: [81] });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('[data-message-id=\"81\"] .message-text')?.textContent==='Updated caption for same received image'",
      )
    );
    const retained = await browser.evaluate(
      "({article:window.__retainedArticle===document.querySelector('[data-message-id=\"81\"]'),image:window.__retainedImage===document.querySelector('[data-message-id=\"81\"] img')})",
    );
    assertEquals(
      retained,
      { article: true, image: true },
      "Canonical metadata changes must update the existing message and native media lifetime",
    );
    assertEquals(
      requests.get(81),
      imageRequestsBeforeRefresh,
      "Unchanged image source must not be refetched by metadata reconciliation",
    );
    assertEquals(browser.errors, []);
    await Deno.writeTextFile(
      `${evidence}/consumer-proof.json`,
      JSON.stringify(
        {
          formats: ["jpeg", "png", "webp", "gif"],
          decodes,
          reserved,
          beforeBelow,
          afterBelow,
          beforePaging,
          afterPaging,
          beforeAbove,
          afterAbove,
          bottomGap,
          switchGap,
          retainedMediaNodes: retained,
          imageRequestsBeforeRefresh,
          imageRequestsAfterRefresh: requests.get(81),
          brokenRequests: requests.get(64),
          errors: browser.errors,
        },
        null,
        2,
      ),
    );
    console.log({
      evidence,
      beforeBelow,
      afterBelow,
      beforePaging,
      afterPaging,
      beforeAbove,
      afterAbove,
      bottomGap,
    });
  } catch (error) {
    if (page) {
      await page.screenshot(`${evidence}/failure-working.png`);
      await Deno.writeTextFile(
        `${evidence}/failure.json`,
        JSON.stringify(
          {
            error: String(error),
            body: await page.evaluate("document.body.innerText"),
            geometry: await page.evaluate(
              "[...document.querySelectorAll('.message-history,.message-media img')].map(e=>({tag:e.tagName,rect:e.getBoundingClientRect().toJSON(),scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}))",
            ),
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await page?.close();
    await service.close();
  }
});
