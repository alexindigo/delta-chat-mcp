// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { click, key, productBuild, type } from "./browser.ts";
import { fixture, lanAddress, poll } from "./support.ts";
import { startService } from "../src/service.ts";
import { loadRuntimeConfig } from "../src/auth/state.ts";
import { createLog } from "../src/log.ts";

const html = (body: string) =>
  `<h1 id='how-to-select-a-chatmail-relay'>Relays</h1><ul><li>${body}</li></ul>`;
const relay = (domain: string) =>
  `<a href='https://${domain}' class='hilite'>${domain}</a>`;
async function chooseCustom(page: Cdp) {
  await click(page, "#public-relay");
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
    page.evaluate<boolean>("!!document.querySelector('#relay')")
  );
}
const ready = (page: Cdp, heading: string) =>
  poll(() =>
    page.evaluate<boolean>(
      `document.querySelector('h1')?.textContent===${JSON.stringify(heading)}`,
    )
  );

Deno.test("native setup flow guides identity and accepted pairing before keys, preserves custom and removed relay choices through bounded refresh", async () => {
  await productBuild();
  const root = await fixture("setup-review"),
    evidence = await Deno.makeTempDir({
      dir: "artifacts",
      prefix: "setup-review-browser-",
    });
  let upstream = "success",
    fetches = 0,
    configured = false,
    paired = false,
    submitted = "";
  const service = await startService(
    loadRuntimeConfig({ DCMCP_DATA_DIR: root, DCMCP_LISTEN_PORT: "0" }).cfg,
    {
      log: createLog("error", [], () => {}),
      relayFetch: (async (_url, init) => {
        fetches++;
        if (upstream === "timeout") {
          return await new Promise((_resolve, reject) =>
            init!.signal!.addEventListener(
              "abort",
              () => reject(init!.signal!.reason),
              { once: true },
            )
          );
        }
        return new Response(
          upstream === "success"
            ? html(relay("fresh.test"))
            : upstream === "empty"
            ? html("")
            : "changed markup",
          { headers: { "content-type": "text/html" } },
        );
      }) as typeof fetch,
    },
  );
  service.app.account.status = () =>
    Promise.resolve({
      configured,
      accountId: 1,
      address: "relay@fixture.test",
      displayName: "Relay fixture",
      connectivity: 4000,
    });
  service.app.account.create = async (input) => {
    configured = true;
    submitted = input.relay;
    return await service.app.account.status();
  };
  service.app.account.invitation = () =>
    Promise.resolve({
      link: "https://i.delta.chat/#fixture",
      svg:
        "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><path d='M10 10h200v200H10z'/></svg>",
    });
  service.app.contacts.list = () =>
    Promise.resolve(
      paired
        ? [{
          id: 10,
          displayName: "Paired phone",
          address: "phone@fixture.test",
          isBlocked: false,
          isKeyContact: true,
          e2eeAvail: true,
        }]
        : [],
    );
  service.app.chats.list = () =>
    Promise.resolve(
      paired
        ? [{
          id: 10,
          name: "Paired phone",
          type: "Single" as const,
          isEncrypted: true,
          isContactRequest: false,
          freshMessageCount: 0,
          lastMessageId: null,
          lastMessageTime: null,
          contactIds: [10],
          summary: "",
        }]
        : [],
    );
  let page: Cdp | undefined;
  try {
    page = await Cdp.launch(
      await fixture("setup-review-browser"),
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
    const origin = `http://delta-chat-mcp.test:${service.addr.port}`;
    await browser.send("Page.navigate", { url: origin + "/" });
    await ready(browser, "Set access");
    await type(browser, "#username", "operator");
    await type(browser, "#password", "private-setup-fixture");
    await click(browser, '[data-action="access-submit"]');
    await ready(browser, "Relay identity");
    assertEquals(await browser.evaluate("location.pathname"), "/identity");
    assertEquals(await browser.evaluate("isSecureContext"), false);
    assertEquals(fetches, 0);
    assertEquals(
      await browser.evaluate("document.querySelector('#public-relay').value"),
      "nine.testrun.org",
    );
    assert(
      await browser.evaluate<boolean>(
        "document.querySelectorAll('#public-relay option').length===25",
      ),
    );
    await type(browser, "#display-name", "Relay fixture");
    await click(browser, '[data-action="refresh-relays"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "document.body.textContent.includes('Public-relay list refreshed.')",
      )
    );
    assertEquals(
      await browser.evaluate("document.querySelector('#public-relay').value"),
      "nine.testrun.org",
    );
    await chooseCustom(browser);
    const custom = "DCACCOUNT:https://private.test/new?invite=fixture";
    await type(browser, "#relay", custom);
    for (upstream of ["changed", "empty", "timeout"]) {
      await click(browser, '[data-action="refresh-relays"]');
      await poll(
        () =>
          browser.evaluate<boolean>(
            "!document.querySelector('[data-action=refresh-relays]').disabled && document.body.textContent.includes('Could not refresh')",
          ),
        10000,
      );
      assertEquals(
        await browser.evaluate("document.querySelector('#relay').value"),
        custom,
      );
      assertEquals(
        await browser.evaluate("document.querySelector('#display-name').value"),
        "Relay fixture",
      );
    }
    await click(browser, '[data-action="create-identity"]');
    await poll(() =>
      browser.evaluate<boolean>(
        "!!document.querySelector('[data-identity-address]')",
      )
    );
    assertEquals(submitted, custom);
    assertEquals(await browser.evaluate("location.pathname"), "/identity");
    await click(browser, '[data-action="setup-next"]');
    await ready(browser, "Contacts");
    // A core update offers the next step without pulling the person away from typing.
    await type(browser, "#contact-invite", "unsent invitation fixture");
    paired = true;
    service.app.events.emit({ type: "contacts" });
    await poll(() =>
      browser.evaluate<boolean>(
        "document.querySelector('[data-action=setup-next]')?.getAttribute('href')==='/keys'",
      )
    );
    assertEquals(await browser.evaluate("location.pathname"), "/contacts");
    assertEquals(
      await browser.evaluate("document.querySelector('#contact-invite').value"),
      "unsent invitation fixture",
    );
    await click(browser, '[data-action="setup-next"]');
    await ready(browser, "Agent access");
    await poll(() =>
      browser.evaluate<boolean>("!document.querySelector('#key-name').disabled")
    );
    await type(browser, "#key-name", "Existing setup agent");
    await click(browser, '[data-action="create-key"]');
    await poll(() =>
      browser.evaluate<boolean>("!!document.querySelector('dialog:modal')")
    );
    await click(browser, '[data-action="dismiss-key"]');
    // Root now observes existing metadata and lands in Chats, never recreates a key.
    await click(browser, "a.brand");
    await ready(browser, "Chats");
    assertEquals(await browser.evaluate("location.pathname"), "/chats");
    assertEquals(service.app.apiKeys.list().length, 1);
    await click(browser, 'a[href="/identity"]');
    await ready(browser, "Relay identity");
    assertEquals(service.app.apiKeys.list().length, 1);
    assertEquals(browser.errors, []);
    console.log({
      evidence,
      privateFixture: true,
      identityPairingKeys: true,
      customPreserved: true,
      removedSelectionPreserved: true,
      refreshTimeoutLastGood: true,
      fetches,
    });
  } finally {
    await page?.close();
    await service.close();
  }
});
