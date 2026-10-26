// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { click, key, productBuild, type } from "./browser.ts";
import { fixture, lanAddress, poll } from "./support.ts";
import { startService } from "../src/service.ts";
import { loadRuntimeConfig } from "../src/auth/state.ts";
import { createLog } from "../src/log.ts";

async function capture(page: Cdp, path: string, regions: string[]) {
  await page.evaluate("scrollTo({top:0,behavior:'instant'})");
  const modal = await page.evaluate<boolean>(
    "!!document.querySelector('dialog:modal')",
  );
  const { cssContentSize } = await page.send("Page.getLayoutMetrics");
  const size = modal
    ? await page.evaluate<{ width: number; height: number }>(
      "({width:innerWidth,height:innerHeight})",
    )
    : cssContentSize as { width: number; height: number };
  const shot = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, ...size, scale: 1 },
  });
  await Deno.writeFile(
    path,
    Uint8Array.from(atob(shot.data as string), (c) => c.charCodeAt(0)),
  );
  for (const [i, selector] of regions.entries()) {
    const rect = await page.evaluate<
      { x: number; y: number; width: number; height: number }
    >(`(()=>{const r=document.querySelector(${
      JSON.stringify(selector)
    }).getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}})()`);
    if (modal) {
      rect.height = Math.min(rect.height, size.height - rect.y);
      rect.width = Math.min(rect.width, size.width - rect.x);
      if (rect.height <= 0 || rect.width <= 0) continue;
    }
    const shot = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...rect, scale: 2 },
    });
    await Deno.writeFile(
      path.replace(".png", `-review${i}.png`),
      Uint8Array.from(atob(shot.data as string), (c) => c.charCodeAt(0)),
    );
  }
}
async function palette(page: Cdp) {
  const pairs = await page.evaluate<{ a: string; b: string; ratio: number }[]>(
    `(()=>{
    const style=getComputedStyle(document.documentElement), rgb=name=>style.getPropertyValue('--'+name).trim();
    const lum=color=>{const hex=color.length===4?[...color.slice(1)].map(c=>c+c).join(''):color.slice(1);const c=hex.match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722};
    return [['ink','sheet'],['quiet','desk'],['quiet','sheet'],['accent','desk'],['accent','sheet'],['on-accent','accent'],['rail-ink','rail'],['rail-quiet','rail'],['control-line','desk'],['control-line','sheet']].map(([a,b])=>{const l=[lum(rgb(a)),lum(rgb(b))].sort((x,y)=>y-x);return {a,b,ratio:(l[0]+.05)/(l[1]+.05)}})
  })()`,
  );
  for (const pair of pairs) {
    assert(
      pair.ratio >= (pair.a === "control-line" ? 3 : 4.5),
      JSON.stringify(pair),
    );
  }
  return pairs;
}
async function nativeSelect(page: Cdp) {
  const geometry = await page.evaluate<{
    inset: number;
    centerDelta: number;
    textGap: number;
    hit: boolean;
    x: number;
    y: number;
  }>(`(async()=>{
    const select=document.querySelector('#public-relay');
    select.scrollIntoView({block:'center',behavior:'instant'});
    await new Promise(requestAnimationFrame);
    const svg=select.parentElement.querySelector('svg'), path=svg.querySelector('path');
    const r=select.getBoundingClientRect(), s=svg.getBoundingClientRect(), box=path.getBBox(), matrix=path.getScreenCTM();
    const edge=new DOMPoint(box.x+box.width,box.y).matrixTransform(matrix).x+parseFloat(getComputedStyle(path).strokeWidth)*matrix.a/2;
    const style=getComputedStyle(select), x=s.x+s.width/2,y=s.y+s.height/2;
    return {inset:r.right-parseFloat(style.borderRightWidth)-edge,centerDelta:Math.abs(r.y+r.height/2-y),textGap:s.x-(r.right-parseFloat(style.paddingRight)),hit:document.elementFromPoint(x,y)===select,x,y};
  })()`);
  assert(
    geometry.inset >= 12 && geometry.inset < 12.1,
    JSON.stringify(geometry),
  );
  assert(geometry.centerDelta < 0.1, JSON.stringify(geometry));
  assert(geometry.textGap >= 8, JSON.stringify(geometry));
  assert(
    geometry.hit,
    "The real select owns the decorative chevron hit target",
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: geometry.x,
      y: geometry.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
  await poll(() =>
    page.evaluate<boolean>(
      "document.querySelector('#public-relay').matches(':open')",
    )
  );
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
      nativeVirtualKeyCode: 35,
    });
  }
  await key(page, "Enter");
  await poll(() =>
    page.evaluate<boolean>(
      "document.querySelector('#public-relay').value==='custom' && !!document.querySelector('#relay')",
    )
  );
  // Reach the control by keyboard from its preceding field, then select a relay.
  await click(page, "#display-name");
  await key(page, "Tab");
  assert(
    await page.evaluate<boolean>(
      "document.activeElement.id==='public-relay' && document.activeElement.matches(':focus-visible')",
    ),
  );
  assertEquals(
    await page.evaluate(
      "({width:getComputedStyle(document.activeElement).outlineWidth,offset:getComputedStyle(document.activeElement).outlineOffset})",
    ),
    { width: "3px", offset: "3px" },
  );
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
      nativeVirtualKeyCode: 40,
      modifiers: 1,
    });
  }
  await poll(() =>
    page.evaluate<boolean>(
      "document.querySelector('#public-relay').matches(':open')",
    )
  );
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Home",
      code: "Home",
      windowsVirtualKeyCode: 36,
      nativeVirtualKeyCode: 36,
    });
  }
  await key(page, "Enter");
  await poll(() =>
    page.evaluate<boolean>(
      "document.querySelector('#public-relay').value==='nine.testrun.org' && !document.querySelector('#public-relay').matches(':open') && !document.querySelector('#relay')",
    )
  );
  assert(
    await page.evaluate<boolean>(
      "document.documentElement.scrollWidth<=innerWidth",
    ),
  );
  return geometry;
}
Deno.test("setup desk renders restrained light/dark palettes, readable controls and sharp bounded native handoff at desktop and 390px", async () => {
  await productBuild();
  await Deno.mkdir("artifacts/setup-review", { recursive: true });
  const evidence = await Deno.makeTempDir({
      dir: "artifacts/setup-review",
      prefix: "visual-",
    }),
    root = await fixture("setup-visual");
  let configured = false;
  const service = await startService(
    loadRuntimeConfig({ DCMCP_DATA_DIR: root, DCMCP_LISTEN_PORT: "0" }).cfg,
    {
      log: createLog("error", [], () => {}),
      relayFetch: () =>
        Promise.reject(new Error("No external fetch in visual fixture")),
    },
  );
  service.app.account.status = () =>
    Promise.resolve({
      configured,
      accountId: 1,
      address: "relay@example.invalid",
      displayName: "My relay desk",
      connectivity: 4000,
    });
  service.app.account.create = async () => {
    configured = true;
    return await service.app.account.status();
  };
  service.app.contacts.list = () => Promise.resolve([]);
  service.app.chats.list = () => Promise.resolve([]);
  service.app.account.invitation = () =>
    Promise.resolve({
      link: "https://i.delta.chat/#nonfunctional-example-invitation",
      svg:
        "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><rect width='220' height='220' fill='white'/><text x='18' y='108' font-size='16'>Example invitation</text><text x='18' y='132' font-size='12'>Not a pairing code</text></svg>",
    });
  // Visual-only API response. Never a working key, and never stored by ApiKeys.
  service.app.apiKeys.create = (name) =>
    Promise.resolve({
      id: "example",
      name,
      created: 1792886400000,
      key: "example_only_not_a_functioning_API_key_save_your_own_key",
    });
  let page: Cdp | undefined;
  try {
    page = await Cdp.launch(
      await fixture("setup-visual-browser"),
      lanAddress(),
      evidence,
    );
    const browser = page;
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.send("Page.navigate", {
      url: `http://delta-chat-mcp.test:${service.addr.port}/`,
    });
    await type(browser, "#username", "operator");
    await type(browser, "#password", "private-visual-fixture");
    await click(browser, '[data-action="access-submit"]');
    await poll(() =>
      browser.evaluate<boolean>("!!document.querySelector('#public-relay')")
    );
    await type(browser, "#display-name", "My relay desk");
    await browser.evaluate("document.fonts.ready");
    const facts: Record<string, unknown> = {
      evidence,
      nonfunctionalExamples: true,
      insecure: await browser.evaluate("!isSecureContext"),
    };
    for (const theme of ["light", "dark"]) {
      await click(browser, '[data-action="open-theme"]');
      await click(browser, `[data-theme-id="globnotes-${theme}"]`);
      await click(browser, '[data-action="theme-done"]');
      await poll(() =>
        browser.evaluate<boolean>(
          `document.documentElement.classList.contains('dark')===${
            theme === "dark"
          }`,
        )
      );
      facts[theme] = await palette(browser);
      facts[`${theme}-select`] = await nativeSelect(browser);
      await capture(browser, `${evidence}/identity-${theme}.png`, [
        ".app-header",
        ".nav-rail",
        ".connection-status",
        ".setup-steps",
        ".identity-screen",
        ".app-footer",
      ]);
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      facts[`${theme}-select-390`] = await nativeSelect(browser);
      await capture(browser, `${evidence}/identity-${theme}-narrow.png`, [
        ".app-header",
        ".nav-rail",
        ".connection-status",
        ".setup-steps",
        ".identity-screen",
        ".app-footer",
      ]);
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    await click(browser, '[data-action="create-identity"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-identity-address]')",
      )
    );
    await click(browser, '[data-action="setup-next"]');
    for (const theme of ["light", "dark"]) {
      await click(browser, '[data-action="open-theme"]');
      await click(browser, `[data-theme-id="globnotes-${theme}"]`);
      await click(browser, '[data-action="theme-done"]');
      await capture(browser, `${evidence}/pairing-${theme}.png`, [
        ".app-header",
        ".nav-rail",
        ".connection-status",
        ".setup-steps",
        ".invite-panel",
        ".contact-join",
        ".contact-requests",
        ".contact-list",
        ".app-footer",
      ]);
    }
    await click(browser, 'a[href="/keys"]');
    for (const theme of ["light", "dark"]) {
      await click(browser, '[data-action="open-theme"]');
      await click(browser, `[data-theme-id="globnotes-${theme}"]`);
      await click(browser, '[data-action="theme-done"]');
      await poll(() =>
        browser.evaluate<boolean>(
          "!document.querySelector('#key-name').disabled",
        )
      );
      await type(browser, "#key-name", "Example agent");
      await click(browser, '[data-action="create-key"]');
      await poll(() =>
        browser.evaluate<boolean>("!!document.querySelector('dialog:modal')")
      );
      await click(browser, '[data-action="copy-key"]');
      await poll(() =>
        browser.evaluate<boolean>(
          "document.querySelector('dialog [role=status]').textContent==='Key copied.'",
        )
      );
      assert(
        await browser.evaluate<boolean>(
          "getComputedStyle(document.querySelector('dialog')).filter==='none' && getComputedStyle(document.querySelector('dialog'),'::backdrop').backdropFilter==='blur(6px)'",
        ),
      );
      await capture(browser, `${evidence}/handoff-${theme}.png`, [
        ".app-header",
        ".nav-rail",
        ".working-sheet",
        ".key-handoff",
        ".key-handoff-copy",
        ".app-footer",
      ]);
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert(
        await browser.evaluate<boolean>(
          "document.documentElement.scrollWidth<=innerWidth && (()=>{const r=document.querySelector('dialog').getBoundingClientRect();return r.x>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()",
        ),
      );
      await capture(browser, `${evidence}/handoff-${theme}-narrow.png`, [
        ".key-handoff",
        ".key-handoff-copy",
      ]);
      await click(browser, '[data-action="dismiss-key"]');
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await click(browser, ".keys-screen > button.text-button");
      await poll(() =>
        browser.evaluate<boolean>(
          "document.querySelector('tbody').textContent.includes('No keys yet')",
        )
      );
    }
    assertEquals(browser.errors, []);
    assertEquals(service.app.apiKeys.list().length, 0);
    await Deno.writeTextFile(
      `${evidence}/proof.json`,
      JSON.stringify(facts, null, 2),
    );
    console.log({
      evidence,
      contrastRoles: true,
      fullThemes: true,
      nativeSharpBlur: true,
      narrow390: true,
      nonfunctionalExampleOnly: true,
    });
  } finally {
    await page?.close();
    await service.close();
  }
});
