// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { click, key, productBuild, type } from "./browser.ts";
import { fixture, lanAddress, poll } from "./support.ts";
import { startService } from "../src/service.ts";
import { loadRuntimeConfig } from "../src/auth/state.ts";
import { createLog } from "../src/log.ts";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
Deno.test("real browser preserves shown-once key and dirty forms across routes/history, protects logout and native reload", async () => {
  await productBuild();
  const root = await fixture("m3-navigation");
  await Deno.mkdir("artifacts/m3", { recursive: true });
  const evidence = await Deno.makeTempDir({
    dir: "artifacts/m3",
    prefix: "navigation-",
  });
  const service = await startService(
    loadRuntimeConfig({ DCMCP_DATA_DIR: root, DCMCP_LISTEN_PORT: "0" }).cfg,
    { log: createLog("error", [], () => {}) },
  );
  let page: Cdp | undefined;
  let releaseKey = () => {};
  try {
    await service.app.auth.setup({
      type: "password",
      username: "operator",
      password: "private-navigation-fixture",
    });
    page = await Cdp.launch(
      await fixture("m3-navigation-browser"),
      lanAddress(),
      evidence,
    );
    const browser = page,
      origin = `http://delta-chat-mcp.test:${service.addr.port}`;
    await browser.send("Page.navigate", { url: `${origin}/keys` });
    await type(browser, "#username", "operator");
    await type(browser, "#password", "private-navigation-fixture");
    await click(browser, '[data-action="access-submit"]');
    await type(browser, "#key-name", "Navigation fixture");
    await click(browser, '[data-action="create-key"]');
    await poll(() =>
      browser.evaluate<boolean>("!!document.querySelector('[data-once-key]')")
    );
    const secret = await browser.evaluate<string>(
      "document.querySelector('[data-once-key]').textContent",
    );
    await click(browser, 'a[href="/contacts"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "location.pathname==='/contacts' && !!document.querySelector('.pending-key')",
      )
    );
    await click(browser, 'a[href="/keys"]');
    await poll(() =>
      browser.evaluate<boolean>("!!document.querySelector('[data-once-key]')")
    );
    assert(
      await browser.evaluate(
        "document.querySelector('[data-once-key]').textContent",
      ) === secret,
      "The shown-once key must survive in-app navigation",
    );
    assert(
      !(await browser.evaluate<string>(
        "JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage})",
      )).includes(secret),
    );
    await click(browser, '[data-action="logout"]');
    await click(browser, '[data-action="keep-work"]');
    assert(
      await browser.evaluate(
        "document.querySelector('[data-once-key]').textContent",
      ) === secret,
      "Cancelling logout must retain the shown-once key",
    );
    await click(browser, '[data-action="dismiss-key"]');
    await click(browser, 'a[href="/identity"]');
    await type(browser, "#display-name", "Unsent name");
    await type(browser, "#relay", "relay.example");
    await click(browser, 'a[href="/contacts"]');
    const history = await browser.send("Page.getNavigationHistory"),
      entries = history.entries as { id: number; url: string }[];
    await browser.send("Page.navigateToHistoryEntry", {
      entryId: entries[(history.currentIndex as number) - 1].id,
    });
    await poll(() =>
      browser.evaluate<boolean>(
        "location.pathname==='/identity' && document.querySelector('#display-name')?.value==='Unsent name'",
      )
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#relay').value"),
      "relay.example",
    );
    const reloading = browser.send("Page.reload");
    await pause(200);
    await browser.send("Page.handleJavaScriptDialog", { accept: false });
    await reloading;
    assertEquals(
      await browser.evaluate("document.querySelector('#display-name').value"),
      "Unsent name",
    );
    await click(browser, '[data-action="logout"]');
    await click(browser, '[data-action="keep-work"]');
    assertEquals(
      await browser.evaluate("document.querySelector('#relay').value"),
      "relay.example",
    );
    await click(browser, '[data-action="logout"]');
    await click(browser, '[data-action="discard-logout"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('h1')?.textContent==='Open your relay'",
      )
    );
    await click(browser, "#username");
    await key(browser, "a", 2);
    await key(browser, "Backspace");
    await type(browser, "#username", "operator");
    await type(browser, "#password", "private-navigation-fixture");
    await click(browser, '[data-action="access-submit"]');
    await poll(() =>
      browser.evaluate<boolean>("!!document.querySelector('#display-name')")
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#display-name').value"),
      "",
    );
    const originalCreate = service.app.apiKeys.create.bind(service.app.apiKeys),
      keyStarted = Promise.withResolvers<void>(),
      keyRelease = Promise.withResolvers<void>();
    releaseKey = () => keyRelease.resolve();
    service.app.apiKeys.create = async (name) => {
      const value = await originalCreate(name);
      keyStarted.resolve();
      await keyRelease.promise;
      return value;
    };
    await click(browser, 'a[href="/keys"]');
    await type(browser, "#key-name", "Late credential");
    await click(browser, '[data-action="create-key"]');
    await keyStarted.promise;
    await click(browser, '[data-action="logout"]');
    await click(browser, '[data-action="discard-logout"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('h1')?.textContent==='Open your relay'",
      )
    );
    releaseKey();
    await pause(100);
    assert(
      await browser.evaluate<boolean>(
        "!document.querySelector('[data-once-key]') && document.querySelector('h1')?.textContent==='Open your relay'",
      ),
    );
    await click(browser, "#username");
    await key(browser, "a", 2);
    await key(browser, "Backspace");
    await type(browser, "#username", "operator");
    await type(browser, "#password", "private-navigation-fixture");
    await click(browser, '[data-action="access-submit"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('tbody')?.textContent.includes('Late credential')",
      )
    );
    assert(
      await browser.evaluate<boolean>(
        "!document.querySelector('[data-once-key]')",
      ),
    );
    assertEquals(browser.errors, []);
    console.log({
      evidence,
      insecure: await browser.evaluate("!isSecureContext"),
      onceKeyRetained: true,
      rawKeyNeverStored: true,
      formHistoryRetained: true,
      nativeReloadCancelled: true,
      logoutDiscardExplicit: true,
      lateKeyResponseAfterLogoutCannotResurrectSecret: true,
    });
  } finally {
    releaseKey();
    await page?.close();
    await service.close();
  }
});
