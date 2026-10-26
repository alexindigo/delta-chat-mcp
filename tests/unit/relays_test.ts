// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  directoryURL,
  parseRelayDirectory,
  PublicRelays,
} from "../../src/messaging/relays.ts";
import { Relays } from "../../web/src/relays.ts";
export const directory = (anchors: string) =>
  `<h1 id='how-to-select-a-chatmail-relay'>Relays</h1><p>Directory</p><ul><li>${anchors}</li></ul><a class='hilite' href='https://outside.test'>outside.test</a>`;
export const anchor = (domain: string) =>
  `<a data-id="x" class='other hilite' href="https://${domain}/">${domain}</a>`;
Deno.test("directory recognition scopes factual anchors, handles multiple per item and rejects unsafe/unrecognized HTML", () => {
  assertEquals(
    parseRelayDirectory(directory(anchor("one.test") + anchor("two.test"))),
    [{ domain: "one.test", homepage: "https://one.test/" }, {
      domain: "two.test",
      homepage: "https://two.test/",
    }],
  );
  for (
    const html of [
      "<ul><li>empty</li></ul>",
      directory(""),
      directory(anchor("one.test").replace("https:", "javascript:")),
      directory(anchor("one.test").replace(">one.test<", ">wrong.test<")),
      directory(
        anchor("one.test").replace("href=", 'href="https://evil.test" href='),
      ),
      directory(anchor("one.test").replace("one.test/", "one.test/path")),
    ]
  ) assertThrows(() => parseRelayDirectory(html));
});
Deno.test("bounded fixed upstream refresh retains last good snapshot on HTTP/HTML/size/timeout failure and deduplicates requests", async () => {
  let mode = "ok", calls = 0;
  const catalog = new PublicRelays(
    (async (url, init) => {
      calls++;
      assertEquals(url, directoryURL);
      assertEquals(init?.redirect, "error");
      if (mode === "timeout") {
        return await new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          )
        );
      }
      return new Response(
        mode === "ok"
          ? directory(anchor("fresh.test"))
          : mode === "huge"
          ? "x".repeat(128 * 1024 + 1)
          : mode === "empty"
          ? directory("")
          : "unrecognized",
        {
          status: mode === "http" ? 503 : 200,
          headers: { "content-type": "text/html" },
        },
      );
    }) as typeof fetch,
    25,
  );
  try {
    assert(catalog.snapshot().relays.length > 20);
    const [a, b] = await Promise.all([catalog.refresh(), catalog.refresh()]);
    assert(a.refreshed);
    assertEquals(a, b);
    assertEquals(calls, 1);
    for (mode of ["http", "empty", "changed", "huge", "timeout"]) {
      const value = await catalog.refresh();
      assertEquals(value.refreshed, false);
      assertEquals(value.relays, a.relays);
    }
    const picker = new Relays({
      relays: () => Promise.resolve(catalog.snapshot()),
      refreshRelays: () => catalog.refresh(),
    }, () => {});
    picker.select("custom");
    picker.custom("DCACCOUNT:https://private.test/new?invite=fixture");
    await picker.load(true);
    assertEquals(
      picker.value,
      "DCACCOUNT:https://private.test/new?invite=fixture",
    );
    picker.select("nine.testrun.org");
    mode = "ok";
    await picker.load(true);
    assertEquals(picker.value, "nine.testrun.org");
    assert(picker.options.includes("nine.testrun.org"));
    assertEquals(
      picker.state.custom,
      "DCACCOUNT:https://private.test/new?invite=fixture",
    );
  } finally {
    catalog.close();
  }
});
