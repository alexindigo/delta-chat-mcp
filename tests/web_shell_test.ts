// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { click, productBuild } from "./browser.ts";
import { fixture, lanAddress, poll } from "./support.ts";
import { startService } from "../src/service.ts";
import { loadRuntimeConfig } from "../src/auth/state.ts";
import { createLog } from "../src/log.ts";

Deno.test("built product shell performs public setup and theme interaction on insecure LAN HTTP with bundled fonts", async () => {
  await productBuild();
  const root = await fixture("web-shell");
  await Deno.mkdir("artifacts/m2", { recursive: true });
  const evidence = await Deno.makeTempDir({
    dir: "artifacts/m2",
    prefix: "shell-",
  });
  const { cfg } = loadRuntimeConfig({
    DCMCP_DATA_DIR: `${root}/service`,
    DCMCP_LISTEN_PORT: "0",
  });
  const service = await startService(cfg, {
    log: createLog("error", [], () => {}),
  });
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(
      await fixture("web-shell-browser"),
      lanAddress(),
      evidence,
    );
    const page = browser;
    await page.send("Page.navigate", {
      url: `http://delta-chat-mcp.test:${service.addr.port}/`,
    });
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('h1')?.textContent === 'Set access'",
      )
    );
    assertEquals(await page.evaluate("isSecureContext"), false);
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await click(page, '[data-action="open-theme"]');
    await click(page, '[data-theme-id="system"]');
    await click(page, '[data-action="theme-done"]');
    await poll(() =>
      page.evaluate<boolean>(
        "document.documentElement.classList.contains('dark')",
      )
    );
    await click(page, 'input[value="public"]');
    await click(page, '[data-action="access-submit"]');
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('h1')?.textContent === 'Relay identity'",
      )
    );
    assertEquals(service.app.auth.mode, "public");
    assertEquals(
      await page.evaluate("document.querySelector('#public-relay').value"),
      "nine.testrun.org",
    );
    assert(
      await page.evaluate<boolean>(
        "document.querySelectorAll('#public-relay option').length > 20 && !document.querySelector('#relay')",
      ),
    );
    await click(page, 'a[href="/keys"]');
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('h1')?.textContent==='Agent access'",
      )
    );
    assert(
      await page.evaluate<boolean>(
        "document.body.textContent.includes('no API key is needed')",
      ),
    );
    await page.evaluate("document.fonts.ready");
    assert(
      await page.evaluate<boolean>(
        "document.fonts.check('16px \"Atkinson Hyperlegible\"') && document.fonts.check('13px \"IBM Plex Mono\"')",
      ),
    );
    await click(page, 'a[href="/contacts"]');
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('h1')?.textContent === 'Contacts'",
      )
    );
    assert(
      await page.evaluate<boolean>(
        "document.body.textContent.includes('Create the relay identity first.') && !!document.querySelector('a[href=\"/identity\"]')",
      ),
    );
    await page.screenshot(`${evidence}/public-dark.png`);
    assertEquals(page.errors, []);
    console.log({
      evidence,
      publicSetup: true,
      fonts: true,
      hitTestedTheme: true,
      messagingNavigation: true,
      secure: false,
    });
  } finally {
    await browser?.close();
    await service.close();
  }
});
