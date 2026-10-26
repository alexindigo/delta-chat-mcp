// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { click, productBuild } from "./browser.ts";
import { fixture, lanAddress, poll } from "./support.ts";
import { startService } from "../src/service.ts";
import { loadRuntimeConfig } from "../src/auth/state.ts";
import { createLog } from "../src/log.ts";

const observer = `(() => {
  window.__themeProof={toggles:[],paints:[]};
  const toggle=DOMTokenList.prototype.toggle;
  DOMTokenList.prototype.toggle=function(token,force){
    const result=arguments.length>1?toggle.call(this,token,force):toggle.call(this,token);
    if(token==='dark' && this===document.documentElement?.classList)window.__themeProof.toggles.push({at:performance.now(),dark:document.documentElement.classList.contains('dark'),css:document.querySelectorAll('link[rel=stylesheet],style').length});
    return result;
  };
  new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__themeProof.paints.push({at:entry.startTime,dark:document.documentElement.classList.contains('dark'),background:getComputedStyle(document.documentElement).backgroundColor});}).observe({type:'paint',buffered:true});
})()`;

async function resolved(page: Cdp, dark: boolean) {
  const expected = dark ? "rgb(34, 38, 44)" : "rgb(255, 255, 255)";
  await poll(() =>
    page.evaluate<boolean>(
      `document.documentElement instanceof Element && getComputedStyle(document.documentElement).backgroundColor===${
        JSON.stringify(expected)
      }`,
    )
  );
  assertEquals(
    await page.evaluate("document.documentElement.classList.contains('dark')"),
    dark,
  );
  assertEquals(
    await page.evaluate("document.documentElement.style.colorScheme"),
    dark ? "dark" : "light",
  );
  assertEquals(
    await page.evaluate(
      "document.querySelector('meta[name=theme-color]').content",
    ),
    dark ? "#22262c" : "#ffffff",
  );
}

Deno.test("Globnotes themes paint correctly before module execution, retain OS/storage behavior and render the access desk", async () => {
  await productBuild();
  const evidence = await Deno.makeTempDir({
    dir: "artifacts/setup-review",
    prefix: "theme-",
  });
  const service = await startService(
    loadRuntimeConfig({
      DCMCP_DATA_DIR: await fixture("theme-browser"),
      DCMCP_LISTEN_PORT: "0",
    }).cfg,
    { log: createLog("error", [], () => {}) },
  );
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(
      await fixture("theme-browser-profile"),
      lanAddress(),
      evidence,
    );
    const page = browser,
      origin = `http://delta-chat-mcp.test:${service.addr.port}`;
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: observer,
    });
    const proofs: unknown[] = [];
    // Blocking only compiled JS proves the static CSS + head bootstrap, not a
    // runtime correction that happened to finish before our assertion.
    await page.send("Network.enable");
    for (
      const fixture of [
        { choice: "system", os: "dark", dark: true },
        { choice: "light", os: "dark", dark: false },
        { choice: "dark", os: "light", dark: true },
        { choice: "invalid", os: "light", dark: false },
        { choice: "denied", os: "dark", dark: true },
      ]
    ) {
      const storage = await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: fixture.choice === "denied"
          ? `Storage.prototype.getItem=Storage.prototype.setItem=function(){throw new Error('fixture storage denied')}`
          : `localStorage.setItem('delta-chat-mcp-theme',${
            JSON.stringify(fixture.choice)
          })`,
      });
      await page.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: fixture.os }],
      });
      await page.send("Network.setBlockedURLs", { urls: ["*assets/*.js"] });
      await page.send("Page.navigate", { url: origin + "/" });
      await resolved(page, fixture.dark);
      // An empty, script-blocked body may never emit a paint entry. Supply an
      // inherited-color fixture marker outside #app so Chromium must paint the
      // fallback theme without running any product module.
      await page.evaluate(
        `(()=>{const marker=document.createElement('p');marker.textContent='Pre-module paint probe';document.body.append(marker)})()`,
      );
      await poll(() =>
        page.evaluate<boolean>("window.__themeProof.paints.length>0")
      );
      assertEquals(
        await page.evaluate("document.querySelector('#app').childElementCount"),
        0,
      );
      const proof = await page.evaluate<
        {
          toggles: { at: number; dark: boolean; css: number }[];
          paints: { at: number; dark: boolean; background: string }[];
        }
      >("window.__themeProof");
      assert(
        proof.toggles.some((toggle) =>
          toggle.css === 0 && toggle.at <= proof.paints[0].at
        ),
      );
      assert(proof.toggles.every((toggle) => toggle.dark === fixture.dark));
      assert(
        proof.paints.every((paint) =>
          paint.dark === fixture.dark &&
          paint.background ===
            (fixture.dark ? "rgb(34, 38, 44)" : "rgb(255, 255, 255)")
        ),
      );
      proofs.push({ fixture, proof });
      await page.send("Network.setBlockedURLs", { urls: [] });
      await page.send("Page.reload");
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('h1')?.textContent==='Set access'",
        )
      );
      await resolved(page, fixture.dark);
      assertEquals(await page.evaluate("isSecureContext"), false);
      if (fixture.choice === "system") {
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "light" }],
        });
        await resolved(page, false);
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        await resolved(page, true);
      }
      if (fixture.choice === "denied") {
        await click(page, "[data-theme=light]");
        await resolved(page, false);
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "light" }],
        });
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        await resolved(page, false);
      }
      await page.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: storage.identifier,
      });
    }
    // Reload removes the denied-storage fixture before proving persisted IDs.
    await page.send("Page.reload");
    await poll(() =>
      page.evaluate<boolean>("!!document.querySelector('[data-theme=light]')")
    );
    for (const theme of ["light", "dark"]) {
      await click(page, `[data-theme=${theme}]`);
      await resolved(page, theme === "dark");
      assertEquals(
        await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
        theme,
      );
      await page.send("Page.reload");
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('h1')?.textContent==='Set access'",
        )
      );
      await resolved(page, theme === "dark");
      await page.evaluate("document.fonts.ready");
      await page.screenshot(`${evidence}/access-${theme}.png`);
      for (
        const [i, selector] of [
          ".app-header",
          ".relay-context",
          ".access-form",
          ".app-footer",
        ].entries()
      ) {
        const rect = await page.evaluate<
          { x: number; y: number; width: number; height: number }
        >(`(()=>{const r=document.querySelector(${
          JSON.stringify(selector)
        }).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
        const shot = await page.send("Page.captureScreenshot", {
          format: "png",
          clip: { ...rect, scale: 2 },
        });
        await Deno.writeFile(
          `${evidence}/access-${theme}-review${i}.png`,
          Uint8Array.from(atob(shot.data as string), (c) => c.charCodeAt(0)),
        );
      }
    }
    assertEquals(page.errors, []);
    await Deno.writeTextFile(
      `${evidence}/proof.json`,
      JSON.stringify(proofs, null, 2),
    );
    console.log({
      evidence,
      preModulePaintCases: proofs.length,
      liveOS: true,
      storageFailure: true,
      persistedIDs: true,
      insecure: true,
    });
  } finally {
    await browser?.close();
    await service.close();
  }
});
