// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { click, key, productBuild } from "./browser.ts";
import { palette, type ThemeId, THEMES } from "../web/src/palette.ts";
import { evidenceDirectory, fixture, lanAddress, poll } from "./support.ts";
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

const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
async function resolved(
  page: Cdp,
  dark: boolean,
  id: ThemeId = dark ? "globnotes-dark" : "globnotes-light",
) {
  const expected = rgb(palette(id).desk);
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
    palette(id).desk,
  );
  assertEquals(
    await page.evaluate("document.documentElement.dataset.theme"),
    id,
  );
}

async function openPicker(page: Cdp) {
  await poll(() =>
    page.evaluate<boolean>(
      "!!document.querySelector('[data-action=open-theme]') && !document.querySelector('[data-action=open-theme]').disabled",
    )
  );
  await click(page, '[data-action="open-theme"]');
  await poll(() =>
    page.evaluate<boolean>("!!document.querySelector('.theme-dialog:modal')")
  );
}
async function choose(page: Cdp, id: string) {
  await openPicker(page);
  await click(page, `[data-theme-id="${id}"]`);
  await poll(() =>
    page.evaluate<boolean>(
      `document.querySelector('[data-theme-id="${id}"]').getAttribute('aria-checked')==='true'`,
    )
  );
  await click(page, '[data-action="theme-done"]');
}
async function shot(page: Cdp, evidence: string, name: string) {
  await page.evaluate("document.fonts.ready");
  const frame = await page.send("Page.captureScreenshot", { format: "png" });
  const data = frame.data as string;
  await Deno.writeFile(
    `${evidence}/${name}.png`,
    Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
  );
  const regions = await page.evaluate<{ label: string; data: string }[]>(
    `(async()=>{
    const image=new Image();image.src='data:image/png;base64,'+${
      JSON.stringify(data)
    };await image.decode();
    const selectors=['.app-header','.relay-context','.access-form','.app-footer','.theme-dialog-header','.theme-system','.theme-family'];
    return selectors.flatMap((s,i)=>[...document.querySelectorAll(s)].flatMap((e,j)=>{
      const r=e.getBoundingClientRect(),scroll=document.querySelector('.theme-picker')?.getBoundingClientRect();
      const x=Math.floor(Math.max(0,r.x)),y=Math.floor(Math.max(0,r.y,i>=5?scroll.top:0)),right=Math.ceil(Math.min(innerWidth,r.right)),bottom=Math.ceil(Math.min(innerHeight,r.bottom,i>=5?scroll.bottom:innerHeight));
      if(right<=x||bottom<=y)return [];const c=document.createElement('canvas');c.width=right-x;c.height=bottom-y;c.getContext('2d').drawImage(image,-x,-y);
      return [{label:i+'-'+j,data:c.toDataURL('image/png').split(',')[1]}];
    }));
  })()`,
  );
  for (const r of regions) {
    await Deno.writeFile(
      `${evidence}/review-${name}-${r.label}.png`,
      Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)),
    );
  }
}

Deno.test("themes paint correctly before module execution, retain fixed defaults and System behavior and render the access desk", async () => {
  await productBuild();
  const evidence = await evidenceDirectory("artifacts/setup-review", "theme-");
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
    const legacyFacts: unknown[] = [];
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
        ...THEMES.map((theme) => ({
          choice: theme.id,
          os: theme.mode === "dark" ? "light" : "dark",
          dark: theme.mode === "dark",
          id: theme.id,
        })),
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
      const id = "id" in fixture
        ? fixture.id
        : fixture.dark
        ? "globnotes-dark"
        : "globnotes-light";
      await resolved(page, fixture.dark, id);
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
            rgb(palette(id).desk)
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
      await resolved(page, fixture.dark, id);
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
        await choose(page, "solarized-light");
        await resolved(page, false, "solarized-light");
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "light" }],
        });
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        await resolved(page, false, "solarized-light");
        await choose(page, "dracula-alucard");
        await resolved(page, false, "dracula-alucard");
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "light" }],
        });
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        await resolved(page, false, "dracula-alucard");
      }
      if ("id" in fixture) {
        await page.send("Emulation.setEmulatedMedia", {
          features: [{
            name: "prefers-color-scheme",
            value: fixture.dark ? "dark" : "light",
          }],
        });
        await resolved(page, fixture.dark, id);
        assertEquals(
          await page.evaluate(
            "document.querySelector('[data-action=open-theme]').textContent",
          ),
          `Theme: ${THEMES.find((t) => t.id === id)!.label}`,
        );
      }
      if (
        ["light", "dark", "globnotes-light", "globnotes-dark"].includes(
          fixture.choice,
        )
      ) {
        const fixed = fixture.dark ? "Dark" : "Light";
        assertEquals(
          await page.evaluate(
            "document.querySelector('[data-action=open-theme]').textContent",
          ),
          `Theme: Default ${fixed}`,
        );
        await openPicker(page);
        const legacy = await page.evaluate<{
          selected: string[];
          focus: string;
          tabStops: string[];
          label: string;
          description: string;
          marker: boolean;
        }>(
          `(()=>{const tile=document.querySelector('[data-theme-id=system]');return {
          selected:[...document.querySelectorAll('[role=radio][aria-checked=true]')].map(e=>e.dataset.themeId),
          focus:document.activeElement.dataset.themeId,
          tabStops:[...document.querySelectorAll('[role=radio][tabindex="0"]')].map(e=>e.dataset.themeId),
          label:tile.getAttribute('aria-label'),description:document.querySelector('#theme-system-description').textContent,
          marker:tile.querySelector('.theme-tile-label').textContent.includes('✓')};})()`,
        );
        assertEquals(legacy.selected, ["system"]);
        assertEquals(legacy.focus, "system");
        assertEquals(legacy.tabStops, ["system"]);
        assert(legacy.marker);
        assert(legacy.label.includes(`saved fixed ${fixed}`));
        assert(legacy.label.includes("select System to follow your device"));
        assertEquals(
          legacy.description,
          `Saved fixed Default ${fixed}. Select System to follow your device.`,
        );
        await page.send("Emulation.setEmulatedMedia", {
          features: [{
            name: "prefers-color-scheme",
            value: fixture.dark ? "light" : "dark",
          }],
        });
        await resolved(page, fixture.dark, id);
        assertEquals(
          await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
          fixture.choice,
        );
        await shot(page, evidence, `legacy-${fixture.choice}`);
        await key(page, "Enter");
        await resolved(page, !fixture.dark);
        assertEquals(
          await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
          "system",
        );
        await page.send("Emulation.setEmulatedMedia", {
          features: [{
            name: "prefers-color-scheme",
            value: fixture.dark ? "dark" : "light",
          }],
        });
        await resolved(page, fixture.dark);
        assertEquals(
          await page.evaluate(
            "document.querySelector('#theme-system-description').textContent",
          ),
          `Now showing Default ${fixed}`,
        );
        legacyFacts.push({
          saved: fixture.choice,
          ...legacy,
          storageUnchangedBeforeActivation: true,
          explicitSystemLive: true,
        });
        await click(page, '[data-action="theme-done"]');
      }
      await page.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: storage.identifier,
      });
    }
    // Reload removes the denied-storage fixture before proving persisted IDs.
    await page.send("Page.reload");
    await poll(() =>
      page.evaluate<boolean>(
        "!!document.querySelector('[data-action=open-theme]')",
      )
    );
    for (const theme of ["light", "dark"]) {
      await choose(page, `solarized-${theme}`);
      await resolved(page, theme === "dark", `solarized-${theme}` as ThemeId);
      assertEquals(
        await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
        `solarized-${theme}`,
      );
      await page.send("Page.reload");
      await poll(() =>
        page.evaluate<boolean>(
          "document.querySelector('h1')?.textContent==='Set access'",
        )
      );
      await resolved(page, theme === "dark", `solarized-${theme}` as ThemeId);
      await page.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await choose(page, "system");
      await resolved(page, theme === "dark");
      await page.evaluate("document.fonts.ready");
      await shot(page, evidence, `access-${theme}`);
    }
    await openPicker(page);
    const expectedIds = ["system", ...THEMES.slice(2).map((t) => t.id)];
    assertEquals(expectedIds.length, 14);
    assertEquals(
      await page.evaluate(
        "[...document.querySelectorAll('[role=radio]')].map(e=>e.dataset.themeId)",
      ),
      expectedIds,
    );
    assertEquals(
      await page.evaluate(
        "[...document.querySelectorAll('.theme-family h3')].map(e=>e.textContent)",
      ),
      [
        "Dracula",
        "Catppuccin",
        "Solarized",
        "Gruvbox",
        "Tokyo Night",
        "Nord",
      ],
    );
    assertEquals(
      await page.evaluate(
        "[...document.querySelectorAll('.theme-system-caption')].map(e=>e.textContent)",
      ),
      ["Default Light", "Default Dark"],
    );
    assertEquals(
      await page.evaluate(
        "document.querySelector('.theme-dialog').textContent.includes('Globnotes')",
      ),
      false,
    );
    const nativeFacts: unknown[] = [];
    for (const theme of THEMES) {
      const defaultLook = theme.id === "globnotes-light" ||
        theme.id === "globnotes-dark";
      const entry = defaultLook ? "system" : theme.id;
      if (defaultLook) {
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme.mode }],
        });
      }
      await click(page, `[data-theme-id="${entry}"]`);
      await resolved(page, theme.mode === "dark", theme.id);
      const fact = await page.evaluate<
        {
          root: Record<string, string>;
          preview: Record<string, string>;
          background: string;
          incoming: string;
          outgoing: string;
          label: string;
          selected: string[];
          check: boolean;
        }
      >(`(()=>{
        const tile=document.querySelector('[data-theme-id="${entry}"]'),preview=tile.querySelector('[data-preview="${theme.id}"]'),roles=${
        JSON.stringify(Object.keys(palette(theme.id)))
      },vars=e=>Object.fromEntries(roles.map(r=>[r,getComputedStyle(e).getPropertyValue('--'+r).trim()]));
        return {root:vars(document.documentElement),preview:vars(preview),background:getComputedStyle(preview).backgroundColor,incoming:getComputedStyle(preview.querySelector('.theme-preview-incoming')).backgroundColor,outgoing:getComputedStyle(preview.querySelector('.theme-preview-outgoing')).backgroundColor,label:document.querySelector('[data-action=open-theme]').textContent,selected:[...document.querySelectorAll('[role=radio][aria-checked=true]')].map(e=>e.dataset.themeId),check:tile.querySelector('.theme-tile-label').textContent.includes('✓')};
      })()`);
      assertEquals(fact.root, palette(theme.id));
      assertEquals(fact.preview, fact.root);
      assertEquals(fact.background, rgb(palette(theme.id).desk));
      assertEquals(fact.incoming, rgb(palette(theme.id).sheet));
      assertEquals(fact.outgoing, rgb(palette(theme.id).accent));
      assertEquals(
        fact.label,
        `Theme: ${defaultLook ? "System" : theme.label}`,
      );
      assertEquals(fact.selected, [entry]);
      assert(fact.check);
      assertEquals(
        await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
        entry,
      );
      nativeFacts.push({ id: theme.id, ...fact });
    }
    // Roving native focus never chooses; explicit Enter/Space do. Wrap + Home/End.
    const focus = async (id: string) =>
      await poll(() =>
        page.evaluate<boolean>(
          `document.activeElement?.dataset.themeId===${JSON.stringify(id)}`,
        )
      );
    await key(page, "Home");
    await focus("system");
    assertEquals(
      await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
      "nord",
    );
    await key(page, "ArrowLeft");
    await focus("nord");
    await key(page, "ArrowRight");
    await focus("system");
    await key(page, "ArrowDown");
    await focus("dracula");
    await key(page, "ArrowUp");
    await focus("system");
    await key(page, "End");
    await focus("nord");
    await key(page, "Home");
    await focus("system");
    assertEquals(
      await page.evaluate(
        "document.querySelector('[role=radio][aria-checked=true]').dataset.themeId",
      ),
      "nord",
    );
    assert(
      await page.evaluate<boolean>(
        "document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineWidth==='3px'",
      ),
    );
    await key(page, "Enter");
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('[data-theme-id=system]').getAttribute('aria-checked')==='true'",
      )
    );
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await resolved(page, false);
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('#theme-system-description').textContent==='Now showing Default Light'",
      )
    );
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await resolved(page, true);
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('#theme-system-description').textContent==='Now showing Default Dark'",
      )
    );
    assertEquals(
      await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
      "system",
    );
    assertEquals(
      await page.evaluate(
        "document.querySelector('[data-action=open-theme]').textContent",
      ),
      "Theme: System",
    );
    await key(page, "ArrowDown");
    await focus("dracula");
    await key(page, " ");
    await resolved(page, true, "dracula");
    await key(page, "Tab");
    assertEquals(
      await page.evaluate("document.activeElement.dataset.action"),
      "theme-done",
    );
    await key(page, "Tab");
    await focus("dracula");
    await key(page, "Escape");
    await poll(() =>
      page.evaluate<boolean>("!document.querySelector('dialog:modal')")
    );
    assertEquals(
      await page.evaluate("localStorage.getItem('delta-chat-mcp-theme')"),
      "dracula",
    );
    await choose(page, "dracula-alucard");
    await shot(page, evidence, "access-alucard");
    await choose(page, "nord");
    await shot(page, evidence, "access-nord");
    await page.send("Page.reload");
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('h1')?.textContent==='Set access'",
      )
    );
    await resolved(page, true, "nord");
    assertEquals(
      await page.evaluate(
        "document.querySelector('[data-action=open-theme]').textContent",
      ),
      "Theme: Nord",
    );
    const layouts: unknown[] = [];
    for (const width of [1280, 390]) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: width === 390 ? 844 : 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await openPicker(page);
      await key(page, "Home");
      await key(page, "Enter");
      const measure = async () => {
        const facts = await page.evaluate<
          {
            fits: boolean;
            overflow: boolean;
            scroll: boolean;
            radios: number;
            tabStops: number;
          }
        >(`(()=>{const d=document.querySelector('.theme-dialog').getBoundingClientRect(),p=document.querySelector('.theme-picker');return {fits:d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight,overflow:document.documentElement.scrollWidth>innerWidth||p.scrollWidth>p.clientWidth,scroll:p.scrollHeight>p.clientHeight,radios:document.querySelectorAll('[role=radio]').length,tabStops:document.querySelectorAll('[role=radio][tabindex="0"]').length}})()`);
        assert(facts.fits && !facts.overflow && facts.scroll);
        assertEquals(facts.radios, 14);
        assertEquals(facts.tabStops, 1);
        return facts;
      };
      layouts.push({ width, ...await measure() });
      // Consecutive overlapping scroll frames show every family without stitching.
      const size = await page.evaluate<{ height: number; total: number }>(
        "(()=>{const p=document.querySelector('.theme-picker');return {height:p.clientHeight,total:p.scrollHeight}})()",
      );
      for (
        let top = 0, frame = 0;
        top < size.total;
        top += Math.floor(size.height * .72), frame++
      ) {
        await page.evaluate(
          `document.querySelector('.theme-picker').scrollTop=${top}`,
        );
        await page.evaluate("new Promise(requestAnimationFrame)");
        await shot(page, evidence, `picker-${width}-${frame}`);
      }
      await measure();
      await click(page, '[data-theme-id="nord"]');
      await shot(page, evidence, `picker-${width}-nord-selected`);
      await click(page, '[data-action="theme-done"]');
    }
    proofs.push({
      nativeFacts,
      legacyFacts,
      keyboardFocusNotActivation: true,
      systemLiveLabel: true,
      layouts,
    });
    assertEquals(page.errors, []);
    await Deno.writeTextFile(
      `${evidence}/proof.json`,
      JSON.stringify(proofs, null, 2),
    );
    console.log({
      evidence,
      preModulePaintCases: proofs.length - 1,
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
