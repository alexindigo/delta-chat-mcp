// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { AccountService } from "../../src/messaging/account.ts";
import { ChangeHub } from "../../src/events.ts";
import { FakeCore } from "./fake_core.ts";

function setup() {
  const ids: number[] = [];
  let configured = false;
  const core = new FakeCore({
    getAllAccountIds: () => Promise.resolve([...ids]),
    addAccount: () => {
      ids.push(7);
      return Promise.resolve(7);
    },
    setConfig: () => Promise.resolve(null),
    addTransportFromQr: () => {
      configured = true;
      return Promise.resolve(null);
    },
    startIo: () => Promise.resolve(null),
    isConfigured: () => Promise.resolve(configured),
    getTransportAddresses: () => Promise.resolve(["fixture@relay.example"]),
    getConfig: (_id, key) => {
      if (key !== "displayname") {
        throw new Error("Obsolete or secret configuration read");
      }
      return Promise.resolve("Fixture");
    },
    getConnectivity: () => Promise.resolve(4000),
    getChatSecurejoinQrCode: () =>
      Promise.resolve("https://i.delta.chat/#fixture"),
    createQrSvg: (text) => Promise.resolve(`<svg>${text}</svg>`),
  });
  return { core, account: new AccountService(core, new ChangeHub()) };
}
Deno.test("single identity creates, configures, starts IO and renders its actual invite", async () => {
  const { core, account } = setup();
  assertEquals((await account.status()).configured, false);
  const result = await account.create({
    relay: "relay.example",
    displayName: "Fixture",
  });
  assertEquals(result.configured, true);
  assertEquals(result.address, "fixture@relay.example");
  assertEquals(core.calls.slice(1, 6), [
    { method: "getAllAccountIds", args: [] },
    { method: "addAccount", args: [] },
    { method: "setConfig", args: [7, "displayname", "Fixture"] },
    { method: "addTransportFromQr", args: [7, "DCACCOUNT:relay.example"] },
    { method: "startIo", args: [7] },
  ]);
  assertEquals(
    await account.inviteQrSvg(),
    "<svg>https://i.delta.chat/#fixture</svg>",
  );
  await assertRejects(
    () => account.create({ relay: "other.example", displayName: "Other" }),
    Error,
    "already exists",
  );
  assertEquals(
    core.calls.filter((call) => call.method === "addAccount").length,
    1,
  );
});
Deno.test("concurrent identity requests cannot create two accounts", async () => {
  const { core, account } = setup();
  const first = account.create({
    relay: "relay.example",
    displayName: "Fixture",
  });
  await assertRejects(
    () => account.create({ relay: "relay.example", displayName: "Second" }),
    Error,
    "in progress",
  );
  await first;
  assertEquals(
    core.calls.filter((call) => call.method === "addAccount").length,
    1,
  );
});

Deno.test("relay domain and full DCACCOUNT URI share one normalization boundary", async () => {
  for (
    const relay of [
      "relay.example",
      " DCACCOUNT:relay.example ",
      "dcaccount:https://relay.example/new",
    ]
  ) {
    const { core, account } = setup();
    await account.create({ relay, displayName: "Fixture" });
    assertEquals(
      core.calls.find((call) => call.method === "addTransportFromQr")?.args,
      [
        7,
        relay.toLowerCase().includes("https:")
          ? "DCACCOUNT:https://relay.example/new"
          : "DCACCOUNT:relay.example",
      ],
    );
  }
});

Deno.test("one invitation pairs its exact link with its SVG even when core rotates each generated token", async () => {
  const { core, account } = setup();
  await account.create({ relay: "relay.example", displayName: "Fixture" });
  let generated = 0;
  core.handlers.getChatSecurejoinQrCode = () =>
    Promise.resolve(`https://i.delta.chat/#token-${++generated}`);
  const result = await account.invitation();
  assertEquals(generated, 1);
  assertEquals(result.svg, `<svg>${result.link}</svg>`);
});
