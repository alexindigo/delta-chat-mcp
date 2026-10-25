// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Cdp } from "./cdp.ts";
import { deadline, poll } from "./support.ts";
export async function click(browser: Cdp, selector: string) {
  await poll(() =>
    browser.evaluate<boolean>(
      `!!document.querySelector(${JSON.stringify(selector)})`,
    )
  );
  const point = await browser.evaluate<{ x: number; y: number; hit: boolean }>(
    `(async () => { const el=document.querySelector(${
      JSON.stringify(selector)
    }); el.scrollIntoView({block:'center',behavior:'instant'}); await new Promise(requestAnimationFrame); const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return {x,y,hit:el===document.elementFromPoint(x,y)||el.contains(document.elementFromPoint(x,y))}; })()`,
  );
  assert(point.hit, `Pointer target must be visible: ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await browser.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
}
export async function type(browser: Cdp, selector: string, text: string) {
  await click(browser, selector);
  await browser.send("Input.insertText", { text });
}
export async function key(browser: Cdp, value: string, modifiers = 0) {
  const code =
    ({ Tab: 9, Enter: 13, Backspace: 8, Escape: 27 } as Record<string, number>)[
      value
    ] ?? value.toUpperCase().charCodeAt(0);
  await browser.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: value,
    code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers,
    ...(value === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  });
  await browser.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: value,
    code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers,
  });
}
export async function productBuild() {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["task", "build:web"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let exited = false;
  const result = child.output().then((value) => {
    exited = true;
    return value;
  });
  try {
    const output = await deadline(result, 60000);
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await result;
    }
  }
}
