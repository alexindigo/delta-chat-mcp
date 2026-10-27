// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { authenticator } from "otplib";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Cdp } from "../cdp.ts";
import { click, key, productBuild, type } from "../browser.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";
import { startService } from "../../src/service.ts";
import { loadRuntimeConfig } from "../../src/auth/state.ts";
import { createLog } from "../../src/log.ts";
import type { AccessMode } from "../../web/src/api.ts";
import { palette, type ThemeId } from "../../web/src/palette.ts";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function fullShot(page: Cdp, path: string) {
  await page.evaluate("scrollTo({top:0,behavior:'instant'})");
  const metrics = await page.send("Page.getLayoutMetrics"),
    size = metrics.cssContentSize as { width: number; height: number };
  const result = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
  });
  await Deno.writeFile(
    path,
    Uint8Array.from(atob(result.data as string), (char) => char.charCodeAt(0)),
  );
  const regions = path.includes("login")
    ? [".app-header", ".relay-context", ".access-form", ".app-footer"]
    : [
      ".app-header",
      ".nav-rail",
      ".key-create",
      ".table-scroll",
      ".connect-config",
      ".app-footer",
    ];
  for (const [index, selector] of regions.entries()) {
    const rect = await page.evaluate<
      { x: number; y: number; width: number; height: number }
    >(`(() => { const r=document.querySelector(${
      JSON.stringify(selector)
    }).getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}; })()`);
    const crop = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...rect, scale: 1 },
    });
    await Deno.writeFile(
      path.replace(".png", `-region${index}-review.png`),
      Uint8Array.from(atob(crop.data as string), (char) => char.charCodeAt(0)),
    );
  }
}
async function fill(page: Cdp, selector: string, value: string) {
  await click(page, selector);
  await key(page, "a", 2);
  await key(page, "Backspace");
  await page.send("Input.insertText", { text: value });
}
const ready = (page: Cdp, heading: string) =>
  poll(
    () =>
      page.evaluate<boolean>(
        `document.querySelector('h1')?.textContent === ${
          JSON.stringify(heading)
        }`,
      ),
    10000,
  );
async function os(page: Cdp, value: "light" | "dark") {
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value }],
  });
}
async function mode(page: Cdp, choice: string) {
  const defaultLook = choice === "light" || choice === "dark";
  if (defaultLook) await os(page, choice);
  const id = defaultLook ? "system" : choice;
  await click(page, '[data-action="open-theme"]');
  await click(page, `[data-theme-id="${id}"]`);
  await poll(() =>
    page.evaluate<boolean>(
      `document.querySelector('[data-theme-id="${id}"]')?.getAttribute('aria-checked') === 'true'`,
    )
  );
  await click(page, '[data-action="theme-done"]');
}
async function dark(
  page: Cdp,
  expected: boolean,
  id: ThemeId = expected ? "globnotes-dark" : "globnotes-light",
) {
  await poll(() =>
    page.evaluate<boolean>(
      `document.documentElement.classList.contains('dark') === ${expected}`,
    )
  );
  assertEquals(
    await page.evaluate(
      "getComputedStyle(document.documentElement).backgroundColor",
    ),
    `rgb(${
      [1, 3, 5].map((i) => parseInt(palette(id).desk.slice(i, i + 2), 16)).join(
        ", ",
      )
    })`,
  );
  assertEquals(
    await page.evaluate("document.documentElement.style.colorScheme"),
    expected ? "dark" : "light",
  );
  assertEquals(
    await page.evaluate(
      "document.querySelector('meta[name=\"theme-color\"]').content",
    ),
    palette(id).desk,
  );
}

// This observes the actual head bootstrap BEFORE CSS exists and compares its
// timestamp to Chromium's first-paint entry. DOMContentLoaded alone proves less.
const paintObserver = `(() => {
  window.__themeProof = { toggles: [], paints: [] };
  const toggle = DOMTokenList.prototype.toggle;
  DOMTokenList.prototype.toggle = function(token, force) {
    const result = arguments.length > 1 ? toggle.call(this,token,force) : toggle.call(this,token);
    if (token === 'dark' && document.documentElement?.classList === this) window.__themeProof.toggles.push({at:performance.now(),dark:document.documentElement.classList.contains('dark'),css:document.querySelectorAll('link[rel=stylesheet],style').length,ready:document.readyState});
    return result;
  };
  new PerformanceObserver(list => { for(const entry of list.getEntries()) window.__themeProof.paints.push({name:entry.name,at:entry.startTime,dark:document.documentElement.classList.contains('dark')}); }).observe({type:'paint',buffered:true});
})()`;

async function prove(modeId: AccessMode, captures: boolean) {
  const root = await fixture(`m2-browser-${modeId}`);
  await Deno.mkdir("artifacts/m2", { recursive: true });
  const evidence = await Deno.makeTempDir({
    dir: "artifacts/m2",
    prefix: `access-${modeId}-`,
  });
  const service = await startService(
    loadRuntimeConfig({
      DCMCP_DATA_DIR: `${root}/service`,
      DCMCP_LISTEN_PORT: "0",
    }).cfg,
    { log: createLog("error", [], () => {}) },
  );
  let browser: Cdp | undefined, client: Client | undefined;
  const facts: Record<string, unknown> = { mode: modeId, evidence };
  try {
    browser = await Cdp.launch(
      await fixture(`m2-browser-profile-${modeId}`),
      lanAddress(),
      evidence,
    );
    const page = browser;
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: paintObserver,
    });
    await os(page, "dark");
    const origin = `http://delta-chat-mcp.test:${service.addr.port}`;
    await page.send("Page.navigate", { url: `${origin}/keys` });
    await ready(page, "Set access");
    assertEquals(await page.evaluate("isSecureContext"), false);
    assertEquals(
      await page.evaluate("location.hostname"),
      "delta-chat-mcp.test",
    );
    await dark(page, true);
    await os(page, "light");
    await dark(page, false);
    await os(page, "dark");
    await dark(page, true);
    await click(page, `input[value="${modeId}"]`);
    let enrollment = "";
    if (modeId !== "public") {
      await type(page, "#username", "operator");
      await type(page, "#password", "m2-browser-private-password");
      if (modeId === "totp") {
        await click(page, '[data-action="enroll"]');
        await poll(() =>
          page.evaluate<boolean>(
            "!!document.querySelector('[data-enrollment-key]')",
          )
        );
        assert(
          await page.evaluate<boolean>(
            "document.querySelector('.enrollment img').complete && document.querySelector('.enrollment img').naturalWidth > 0",
          ),
        );
        enrollment = await page.evaluate<string>(
          "document.querySelector('[data-enrollment-key]').textContent",
        );
        await type(page, "#code", authenticator.generate(enrollment));
      }
    }
    // Structural geometry is measured, not inferred from CSS or a screenshot.
    const geometry = await page.evaluate<
      { centers: number[]; lineCenters: number[] }
    >(`({centers:[...document.querySelectorAll('.relay-station i')].map(e=>{const r=e.getBoundingClientRect();return r.x+r.width/2}),lineCenters:[...document.querySelectorAll('.relay-line')].map(e=>{const r=e.getBoundingClientRect();return r.x+r.width/2})})`);
    assert(
      geometry.centers.every((x) => Math.abs(x - geometry.centers[0]) < 0.5),
    );
    assert(
      geometry.lineCenters.every((x) =>
        Math.abs(x - geometry.centers[0]) < 0.5
      ),
    );
    await click(page, '[data-action="access-submit"]');
    await ready(page, "Agent access");
    assertEquals(service.app.auth.mode, modeId);
    facts.setup = true;
    if (modeId === "public") {
      assert(
        await page.evaluate<boolean>(
          "document.body.textContent.includes('no API key is needed')",
        ),
      );
      const config = JSON.parse(
        await page.evaluate<string>(
          "document.querySelector('pre code').textContent",
        ),
      );
      assertEquals(config.mcp["delta-chat"].headers, undefined);
      assertEquals(config.mcp["delta-chat"].url, `${origin}/mcp`);
      await page.send("Page.reload");
      await ready(page, "Agent access");
      facts.noKeyNeeded = true;
    } else {
      await type(page, "#key-name", "Session agent");
      await click(page, '[data-action="create-key"]');
      await poll(() =>
        page.evaluate<boolean>("!!document.querySelector('[data-once-key]')")
      );
      const rawKey = await page.evaluate<string>(
        "document.querySelector('[data-once-key]').textContent",
      );
      assert(
        /^dcm_[A-Za-z0-9_-]{43}$/.test(rawKey),
        "A real API key is shown once",
      );
      assertEquals(
        await page.evaluate("typeof navigator.clipboard"),
        "undefined",
      );
      await click(page, '[data-action="copy-key"]');
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('dialog [role=status]')?.textContent === 'Key copied.'",
        )
      );
      await click(page, '[data-action="dismiss-key"]');
      await poll(() =>
        page.evaluate<boolean>("!document.querySelector('[data-once-key]')")
      );
      await click(page, "#key-name");
      await key(page, "v", 2);
      await poll(() =>
        page.evaluate<boolean>(
          `document.querySelector('#key-name').value === ${
            JSON.stringify(rawKey)
          }`,
        )
      );
      await fill(page, "#key-name", "");
      assert(
        !await page.evaluate<boolean>(
          `document.body.textContent.includes(${JSON.stringify(rawKey)})`,
        ),
      );
      facts.httpClipboardCopyToRealBrowserPaste = true;
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://${lanAddress()}:${service.addr.port}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${rawKey}` } } },
      );
      client = new Client({ name: "browser-created-key", version: "0" });
      await deadline(client.connect(transport));
      const status = await client.callTool({ name: "status", arguments: {} });
      assert(!status.isError);
      await click(page, "button.text-button");
      await poll(() =>
        page.evaluate<boolean>(
          "!document.querySelector('tbody').textContent.includes('Never')",
        )
      );
      const configText = await page.evaluate<string>(
          "document.querySelector('pre code').textContent",
        ),
        config = JSON.parse(configText);
      assertEquals(config.mcp["delta-chat"].url, `${origin}/mcp`);
      assertEquals(config.mcp["delta-chat"].oauth, false);
      assertEquals(
        config.mcp["delta-chat"].headers.Authorization,
        "Bearer {env:DELTA_CHAT_MCP_KEY}",
      );
      assert(!configText.includes(rawKey));
      await click(page, '[data-action="copy-config"]');
      await page.evaluate(
        "(() => {const area=document.createElement('textarea');area.id='paste-probe';area.setAttribute('aria-label','Test paste destination');document.body.append(area)})()",
      );
      await click(page, "#paste-probe");
      await key(page, "v", 2);
      await poll(() =>
        page.evaluate<boolean>(
          `document.querySelector('#paste-probe').value === ${
            JSON.stringify(configText)
          }`,
        )
      );
      await page.evaluate("document.querySelector('#paste-probe').remove()");
      await mode(page, "solarized-light");
      await dark(page, false, "solarized-light");
      await page.send("Page.reload");
      await ready(page, "Agent access");
      await dark(page, false, "solarized-light");
      assertEquals(
        await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
        "solarized-light",
      );
      await mode(page, "system");
      await os(page, "light");
      await dark(page, false);
      await os(page, "dark");
      await dark(page, true);
      await mode(page, "solarized-dark");
      await os(page, "light");
      await page.send("Page.reload");
      await ready(page, "Agent access");
      await dark(page, true, "solarized-dark");
      await poll(() =>
        page.evaluate<boolean>(
          "window.__themeProof.paints.some(p=>p.name==='first-paint')",
        )
      );
      const paint = await page.evaluate<
        {
          toggles: { at: number; dark: boolean; css: number; ready: string }[];
          paints: { name: string; at: number; dark: boolean }[];
        }
      >("window.__themeProof");
      const firstPaint = paint.paints.find((entry) =>
        entry.name === "first-paint"
      )!;
      assert(
        paint.toggles[0].dark && paint.toggles[0].css === 0 &&
          paint.toggles[0].ready === "loading",
      );
      assert(paint.toggles[0].at < firstPaint.at && firstPaint.dark);
      facts.preStylesheetPreFirstPaint = paint;
      // Keyboard is actual browser key input, including visible native focus.
      await mode(page, "system");
      await click(page, '[data-action="open-theme"]');
      await key(page, "ArrowRight");
      await poll(() =>
        page.evaluate<boolean>(
          "document.activeElement?.getAttribute('data-theme-id') === 'dracula'",
        )
      );
      assert(
        await page.evaluate<boolean>(
          "document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineWidth === '3px'",
        ),
      );
      await key(page, "Enter");
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('[data-theme-id=dracula]').getAttribute('aria-checked')==='true'",
        )
      );
      await dark(page, true, "dracula");
      await key(page, "ArrowRight");
      await poll(() =>
        page.evaluate<boolean>(
          "document.activeElement?.getAttribute('data-theme-id')==='dracula-alucard'",
        )
      );
      await key(page, "Enter");
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('[data-theme-id=dracula-alucard]').getAttribute('aria-checked')==='true'",
        )
      );
      await dark(page, false, "dracula-alucard");
      assertEquals(
        await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
        "dracula-alucard",
      );
      await click(page, '[data-action="theme-done"]');
      facts.keyboardTheme = true;
      const blocked = await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source:
          `Storage.prototype.getItem=function(){throw new Error('fixture storage denied')}; Storage.prototype.setItem=function(){throw new Error('fixture storage denied')};`,
      });
      await os(page, "dark");
      await page.send("Page.reload");
      await ready(page, "Agent access");
      await dark(page, true);
      await mode(page, "solarized-light");
      await dark(page, false, "solarized-light");
      await os(page, "dark");
      await dark(page, false, "solarized-light");
      facts.storageErrorsHandled = true;
      await page.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: blocked.identifier,
      });
      await page.send("Page.reload");
      await ready(page, "Agent access");
      await page.evaluate("document.fonts.ready");
      await poll(() =>
        page.evaluate<boolean>(
          "[...document.fonts].some(f=>f.family.includes('Atkinson Hyperlegible')&&f.status==='loaded') && [...document.fonts].some(f=>f.family.includes('IBM Plex Mono')&&f.status==='loaded')",
        )
      );
      assert(
        await page.evaluate<boolean>(
          "[...document.fonts].some(f=>f.family.includes('Atkinson Hyperlegible')&&f.status==='loaded') && [...document.fonts].some(f=>f.family.includes('IBM Plex Mono')&&f.status==='loaded')",
        ),
      );
      const alignment = await page.evaluate<
        { inputBottom: number; buttonBottom: number }
      >(`({inputBottom:document.querySelector('#key-name').getBoundingClientRect().bottom,buttonBottom:document.querySelector('[data-action=create-key]').getBoundingClientRect().bottom})`);
      assert(Math.abs(alignment.inputBottom - alignment.buttonBottom) < 0.5);
      if (captures) {
        await mode(page, "light");
        await dark(page, false);
        await fullShot(page, `${evidence}/keys-light.png`);
        await mode(page, "dark");
        await dark(page, true);
        await fullShot(page, `${evidence}/keys-dark.png`);
      }
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert(
        await page.evaluate<boolean>(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      );
      await page.screenshot(`${evidence}/keys-mobile-working.png`);
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await click(page, '[data-action="ask-delete"]');
      await click(page, '[data-action="cancel-delete"]');
      assert(
        !(await client.callTool({ name: "status", arguments: {} })).isError,
      );
      await click(page, '[data-action="ask-delete"]');
      await click(page, '[data-action="delete-key"]');
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('tbody').textContent.includes('No keys yet')",
        )
      );
      const reused = await fetch(
        `http://${lanAddress()}:${service.addr.port}/mcp`,
        {
          headers: {
            Authorization: `Bearer ${rawKey}`,
            "mcp-session-id": transport.sessionId!,
          },
        },
      );
      assertEquals(reused.status, 401);
      assertEquals(reused.headers.get("www-authenticate"), "Bearer");
      await reused.body?.cancel();
      facts.browserDeleteRevokesInitializedMcp = true;
      await client.close();
      client = undefined;
      await click(page, '[data-action="logout"]');
      await ready(page, "Open your relay");
      const protectedRoute = await fetch(
        `http://${lanAddress()}:${service.addr.port}/api/keys`,
      );
      assertEquals(protectedRoute.status, 401);
      await protectedRoute.body?.cancel();
      if (captures) {
        await mode(page, "light");
        await dark(page, false);
        await fullShot(page, `${evidence}/login-light.png`);
        await mode(page, "dark");
        await dark(page, true);
        await fullShot(page, `${evidence}/login-dark.png`);
      }
      await fill(page, "#username", "operator");
      await type(page, "#password", "incorrect-fixture-password");
      if (modeId === "totp") {
        await type(page, "#code", authenticator.generate(enrollment));
      }
      await click(page, '[data-action="access-submit"]');
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('[role=alert]')?.textContent === 'Incorrect credentials'",
        )
      );
      assert(
        await page.evaluate<boolean>(
          "document.querySelector('#password').value === 'incorrect-fixture-password'",
        ),
      );
      await fill(page, "#password", "m2-browser-private-password");
      if (modeId === "totp") {
        await pause(30000 - Date.now() % 30000 + 150);
        await fill(page, "#code", authenticator.generate(enrollment));
      }
      await click(page, '[data-action="access-submit"]');
      await ready(page, "Agent access");
      facts.logoutAndFreshLogin = true;
    }
    assertEquals(page.errors, []);
    await Deno.writeTextFile(
      `${evidence}/consumer-proof.json`,
      JSON.stringify(facts, null, 2),
    );
    console.log(JSON.stringify(facts));
  } catch (error) {
    if (browser) {
      facts.fontFailureProbe = await browser.evaluate(
        "({fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),fontStatus:document.fonts.status,bodyFont:getComputedStyle(document.body).fontFamily,codeFont:document.querySelector('pre code')?getComputedStyle(document.querySelector('pre code')).fontFamily:null,ready:document.readyState})",
      );
    }
    await Deno.writeTextFile(
      `${evidence}/failure-observation.json`,
      JSON.stringify(facts, null, 2),
    );
    console.log(JSON.stringify(facts));
    throw error;
  } finally {
    await client?.close();
    await browser?.close();
    await service.close();
  }
}

Deno.test("real insecure-HTTP browser proves all access modes, copy-paste MCP keys, revocation, themes before paint, keyboard and full screenshots", async () => {
  await productBuild();
  await prove("public", false);
  await prove("password", true);
  await prove("totp", false);
});
