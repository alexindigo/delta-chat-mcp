// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { poll } from "../../../tests/support.ts";
import { ProviderFixture } from "./support/provider_fixture.ts";
import { McpFixture } from "./support/mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./support/opencode_process.ts";
import { relayWorld } from "./support/relay_world.ts";

// Uses only the fixture's CI identities and the two existing v1 pins.
// Observes native consumer input, actual final reply AND stock-peer mirror.
Deno.test("standard MCP plugin: latest recipient, read/leave routing, native final mirror and real model self-send correlation", async () => {
  const provider = new ProviderFixture(),
    mcp = new McpFixture(),
    delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  let world: Awaited<ReturnType<typeof relayWorld>> | undefined;
  try {
    world = await relayWorld();
    const { url, headers } = world.first.config;
    const bundle =
      new URL("../dist/delta-chat-mcp-opencode.js", import.meta.url).href;
    await oc.configure({
      plugin: [[bundle, {
        relays: { relay: { url, headers, enabled: true } },
        stateFile: `${oc.root}/standard/progress.sqlite`,
      }]],
      mcp: {},
    });
    await oc.start();
    const a = await oc.session("standard older"),
      b = await oc.session("standard latest");
    const turn = async (
      session: string,
      name: string,
      args: Record<string, unknown>,
    ) => {
      provider.queue.push({ tool: { name, args } }, {
        text: "main-channel-result-no-broadcast",
      });
      const id = `msg_standard${crypto.randomUUID().replaceAll("-", "")}`;
      await oc.prompt(session, {
        messageID: id,
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "Run the requested fixture tool" }],
      });
      await oc.final(session, id);
      const part = (await oc.messages(session)).flatMap((m) => m.parts)
        .findLast((p) => p.tool === name);
      assertEquals(part?.state?.status, "completed");
      const result = JSON.parse(part!.state!.output!);
      assert(!result.isError);
      assertEquals(
        result.content[0].text,
        JSON.stringify(result.structuredContent),
      );
      return result.structuredContent;
    };
    const seed = `standard-seed-${crypto.randomUUID()}`;
    await world.tool(world.first.client, "send_message", {
      chat_id: world.room,
      text: seed,
    });
    await world.receives(seed);
    await turn(a.id, "relay_room_subscribe", { chat_id: world.room });
    await turn(b.id, "relay_room_subscribe", { chat_id: world.room });
    const keyOwner = world.first.service.app.apiKeys.list()[0].id as string;
    const routing = world.first.service.app.routing!;
    assertEquals(
      routing.subscriptions(keyOwner, b.id).subscriptions[0].recipient,
      true,
    );
    assertEquals(
      routing.subscriptions(keyOwner, a.id).subscriptions[0].subscribed,
      true,
    );
    assertEquals(
      routing.subscriptions(keyOwner, a.id).subscriptions[0].recipient,
      false,
    );
    const wakeRows = async (session: string) =>
      (await oc.messages(session)).filter((m) =>
        m.parts.some((p) => p.metadata?.deltaChatWake !== undefined)
      );
    const firstText = `standard-peer-b-${crypto.randomUUID()}`,
      firstAnswer = `standard-final-b-${crypto.randomUUID()}`;
    provider.queue.push({ text: firstAnswer });
    const incoming = await world.quotedReply(firstText, seed);
    await poll(async () => (await wakeRows(b.id)).length === 1, 60_000);
    const input = (await wakeRows(b.id))[0];
    assertEquals((await wakeRows(a.id)).length, 0);
    assert(input.parts.some((p) => p.text?.includes(firstText)));
    const facts = input.parts.find((p) => p.metadata?.deltaChatWake)?.metadata
      ?.deltaChatWake as { messageIds: number[]; deliveryId: string };
    assertEquals(facts.messageIds, [incoming.id]);
    await oc.final(b.id, input.info.id);
    await world.receivesComplete(firstAnswer);
    await poll(
      () =>
        routing.inbox(keyOwner).deliveries.some((d) =>
          d.delivery_id === facts.deliveryId && d.state === "completed"
        ),
      60_000,
    );

    await turn(a.id, "relay_read_messages", { chat_id: world.room });
    const notices = routing.store.read().notices.length;
    await turn(a.id, "relay_read_messages", { chat_id: world.room });
    assertEquals(routing.store.read().notices.length, notices);
    assertEquals(
      routing.subscriptions(keyOwner, a.id).subscriptions[0].recipient,
      true,
    );
    const secondText = `standard-peer-a-${crypto.randomUUID()}`,
      secondAnswer = `standard-final-a-${crypto.randomUUID()}`;
    provider.queue.push({ text: secondAnswer });
    await world.quotedReply(secondText, seed);
    await poll(async () => (await wakeRows(a.id)).length === 1, 60_000);
    await world.receivesComplete(secondAnswer);
    assertEquals((await wakeRows(b.id)).length, 1);

    await turn(b.id, "relay_room_subscribe", { chat_id: world.room });
    const selfAnswer = `standard-explicit-final-${crypto.randomUUID()}`;
    provider.queue.push({
      tool: {
        name: "relay_send_message",
        args: { chat_id: world.room, text: selfAnswer },
      },
    }, { text: selfAnswer });
    await world.quotedReply(
      `standard-explicit-request-${crypto.randomUUID()}`,
      seed,
    );
    await poll(async () => (await wakeRows(b.id)).length === 2, 60_000);
    await world.receivesComplete(selfAnswer);
    await poll(
      () =>
        routing.inbox(keyOwner).deliveries.some((d) =>
          d.target_session === b.id && d.outcome === "answered_by_model"
        ),
      60_000,
    );
    assertEquals(
      (await world.first.service.app.chats.messages(world.room, { limit: 100 }))
        .filter((m) => m.fromSelf && m.text === selfAnswer).length,
      1,
    );

    await turn(b.id, "relay_room_leave", { chat_id: world.room });
    assertEquals(
      routing.subscriptions(keyOwner, a.id).subscriptions[0].recipient,
      true,
    );
    assertEquals(
      routing.subscriptions(keyOwner, b.id).subscriptions[0].subscribed,
      false,
    );
    const history = await world.first.service.app.chats.messages(world.room, {
      limit: 100,
    });
    assert(!history.some((m) => m.text === "main-channel-result-no-broadcast"));
    assertEquals(provider.queue.length, 0);
    assertEquals(provider.unexpected, []);
  } finally {
    await oc.close();
    await world?.close();
    await delay.close();
    await mcp.close();
    await provider.close();
  }
});
