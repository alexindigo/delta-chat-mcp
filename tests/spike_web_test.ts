// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import {
  deadline,
  evidenceDirectory,
  fixture,
  lanAddress,
  poll,
} from "./support.ts";

async function buildWeb(evidence: string) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.3.5",
      "build",
      "--config",
      "tests/fixtures/counter.vite.ts",
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let exited = false;
  const output = child.output().then((result) => {
    exited = true;
    return result;
  });
  try {
    const result = await deadline(output, 60_000);
    const log = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    await Deno.writeTextFile(`${evidence}/build.log`, log);
    console.log(log);
    assertEquals(
      result.code,
      0,
      "The selected Solid 2 native toolchain must build",
    );
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await deadline(output, 5_000);
    }
  }
}

Deno.test("Solid 2 native build renders and reacts 0 → 1 in insecure non-loopback HTTP Chromium", async () => {
  const evidence = await evidenceDirectory("artifacts/m0", "web-");
  await buildWeb(evidence);
  const dist = new URL("../artifacts/m0/counter-dist/", import.meta.url);
  assert((await Deno.stat(new URL("index.html", dist))).isFile);
  const address = lanAddress();
  const requests: string[] = [];
  const http = Deno.serve(
    { hostname: address, port: 0, onListen() {} },
    async (request) => {
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      if (pathname === "/favicon.ico") {
        return new Response(null, {
          status: 204,
        });
      }
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      if (
        !/^(index\.html|assets\/[^/]+\.(js|css))$/.test(name)
      ) return new Response(null, { status: 404 });
      return new Response(await Deno.readFile(new URL(name, dist)), {
        headers: {
          "content-type": name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".css")
            ? "text/css"
            : "text/html",
        },
      });
    },
  );
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(await fixture("web"), address, evidence);
    const url = `http://delta-chat-mcp.test:${http.addr.port}/`;
    await browser.send("Page.navigate", { url });
    const page = browser;
    await poll(
      () =>
        page.evaluate<boolean>(
          "document.querySelector('button')?.textContent === '0'",
        ),
      10_000,
    );
    assertEquals(await browser.evaluate("location.protocol"), "http:");
    assertEquals(
      await browser.evaluate("location.hostname"),
      "delta-chat-mcp.test",
    );
    assertEquals(await browser.evaluate("isSecureContext"), false);
    assert(
      requests.some((path) => /^\/assets\/.+\.js$/.test(path)),
      "Browser must consume the built JS bundle",
    );
    await browser.screenshot(`${evidence}/counter-0.png`);
    const point = await browser.evaluate<
      { x: number; y: number; hit: boolean; width: number; height: number }
    >(`(async () => {
      const button = document.querySelector('button');
      button.scrollIntoView({block:'center',behavior:'instant'});
      await new Promise(requestAnimationFrame);
      const r = button.getBoundingClientRect();
      const x = r.x + r.width/2, y = r.y + r.height/2;
      return {x,y,hit:document.elementFromPoint(x,y)===button,width:r.width,height:r.height};
    })()`);
    assert(point.hit && point.width > 0 && point.height > 0);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await poll(() =>
      page.evaluate<boolean>(
        "document.querySelector('button')?.textContent === '1'",
      )
    );
    await browser.screenshot(`${evidence}/counter-1.png`);
    assertEquals(browser.errors, []);
    const receipt = {
      url,
      address,
      isSecureContext: false,
      before: "0",
      after: "1",
      point,
      errors: browser.errors,
      requests,
      evidence,
    };
    await Deno.writeTextFile(
      `${evidence}/browser.json`,
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt));
  } finally {
    try {
      await browser?.close();
    } finally {
      await http.shutdown();
    }
  }
});
