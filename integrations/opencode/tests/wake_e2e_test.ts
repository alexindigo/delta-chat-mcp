// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { poll } from "../../../tests/support.ts";
import { ProviderFixture } from "./support/provider_fixture.ts";
import { McpFixture } from "./support/mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./support/opencode_process.ts";
import { relayWorld } from "./support/relay_world.ts";
import { epochContract } from "./support/j4_epoch_contract.ts";
import { nativeWake } from "./support/j4_wake.ts";
import { reviewWake } from "./support/j4_review.ts";
import { mirrorWake } from "./support/j5_mirror.ts";

Deno.test("J5 real native room mirroring", mirrorWake);

Deno.test("J4 review closures real native", reviewWake);

Deno.test("J4 real native room wake", nativeWake);

Deno.test(
  "J4 C24b process capability across actual artifact URLs",
  epochContract,
);

Deno.test("J3 real relay + actual bundled modern subscription proxies S1-S9", async (t) => {
  const provider = new ProviderFixture(),
    mcp = new McpFixture(),
    delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  const state = `${oc.root}/subscriptions/wake.sqlite`;
  const bundle =
    new URL("../dist/delta-chat-mcp-opencode.js", import.meta.url).href;
  const options = {
    relays: {} as Record<string, {
      url: string;
      headers: Record<string, string>;
      enabled: boolean;
    }>,
    stateFile: state,
  };
  let world: Awaited<ReturnType<typeof relayWorld>> | undefined;
  const rows = async () => {
    const result = [];
    for (const edge of [world!.first, world!.second]) {
      const identity = await edge.service.app.account.status();
      const router = edge.service.app.routing!;
      for (const room of router.store.read().rooms) {
        for (const member of room.members) {
          result.push({
            session_id: member.session_id,
            relay: identity.address,
            chat_id: room.chat_id,
            state: member.joined ? room.state : "left",
            anchor_id: room.anchor_id,
            interval: room.interval,
            recipient: room.recipient ===
              JSON.stringify([member.namespace, member.session_id]),
          });
        }
      }
    }
    return result;
  };
  const proof = async (scenario: string, facts: Record<string, unknown>) => {
    const row = {
      time: new Date().toISOString(),
      scenario,
      version: await oc.version(),
      providerRequests: provider.requests.length,
      ...facts,
    };
    await Deno.writeTextFile(
      `${oc.root}/j3-facts.jsonl`,
      JSON.stringify(row) + "\n",
      { append: true, mode: 0o600 },
    );
    console.log(JSON.stringify(row));
  };
  const turn = async (
    session: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const before = provider.requests.length;
    provider.queue.push({ tool: { name, args } }, {
      text: "J3 deterministic final",
    });
    const message = `msg_j3${crypto.randomUUID().replaceAll("-", "")}`;
    await oc.prompt(session, {
      messageID: message,
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: "J3 deterministic scenario" }],
    });
    await oc.final(session, message);
    assertEquals(provider.requests.length - before, 2);
    assertEquals(provider.queue.length, 0);
    const part = (await oc.messages(session)).flatMap((m) => m.parts).findLast((
      p,
    ) => p.tool === name);
    assert(part, "Actual tool part must exist");
    return part;
  };
  const send = async (
    session: string,
    alias: string,
    args: Record<string, unknown>,
  ) => {
    const part = await turn(session, `${alias}_send_message`, args);
    assertEquals(part.state?.status, "completed");
    const envelope = JSON.parse(part.state!.output!);
    assert(!envelope.isError);
    assertEquals(
      envelope.content[0].text,
      JSON.stringify(envelope.structuredContent),
    );
    const sent = envelope.structuredContent;
    assert(Number.isSafeInteger(sent.message_id) && sent.message_id > 0);
    return { part, sent };
  };
  const step = async (name: string, run: () => Promise<void>) => {
    if (!await t.step(name, run)) {
      throw new Error(`J3 ${name} failed; preserved ${oc.root}`);
    }
  };
  try {
    world = await relayWorld();
    const relay = (
      config: { url: string; headers: Record<string, string> },
    ) => ({
      url: config.url,
      headers: config.headers,
      enabled: true,
    });
    options.relays = {
      "relay.one": relay(world.first.config),
      twin: relay(world.first.config),
      second: relay(world.second.config),
    };
    await oc.configure({
      plugin: [[bundle, options]],
      mcp: {},
    });
    await oc.start();
    const writer = await oc.session("J3 writer"),
      other = await oc.session("J3 second writer");
    let firstAnchor = 0;
    let contactAnchor = 0;
    await step(
      "S1 room send subscribes; matching MCP envelope reaches provider and server list",
      async () => {
        const text = `J3-S1-${crypto.randomUUID()}`;
        const { sent } = await send(writer.id, "relay_one", {
          chat_id: world!.room,
          text,
        });
        firstAnchor = sent.message_id;
        const actual = (await rows()).filter((r) => r.session_id === writer.id);
        assertEquals(actual.length, 1);
        assertEquals(sent.routing.anchor_id, sent.message_id);
        assertEquals(actual[0].chat_id, world!.room);
        const identity = await world!.tool<{ address: string }>(
          world!.first.client,
          "status",
        );
        assertEquals(actual[0].relay, identity.address);
        assertEquals(sent.routing.subscribed, true);
        assertStringIncludes(
          JSON.stringify(provider.requests.at(-1)),
          "subscribed",
        );
        const peer = await world!.receives(text);
        const list = await turn(writer.id, "relay_one_room_subscriptions", {});
        assertEquals(list.state?.status, "completed");
        const data = JSON.parse(list.state!.output!).structuredContent;
        assertEquals(data.subscriptions.length, 1);
        assertEquals(data.subscriptions[0].recipient, true);
        assert(!JSON.stringify(data).includes("Authorization"));
        await proof("S1", {
          session: writer.id,
          room: world!.room,
          canonicalAlias: "relay_one",
          anchor: firstAnchor,
          peerMessage: peer.id,
          rows: actual.length,
          noticeAtConsumer: true,
          listAtConsumer: true,
        });
      },
    );
    await step("S2 contact send resolves canonical chat", async () => {
      const { sent } = await send(writer.id, "relay_one", {
        contact_id: world!.contact,
        text: `J3-S2-${crypto.randomUUID()}`,
      });
      assert(sent.chat_id !== world!.room);
      contactAnchor = sent.message_id;
      assert(
        !(await rows()).some((r) =>
          r.session_id === writer.id && r.chat_id === sent.chat_id
        ),
      );
      await proof("S2", {
        session: writer.id,
        contact: world!.contact,
        resolvedChat: sent.chat_id,
        message: sent.message_id,
      });
    });
    await step(
      "S3 repeated send keeps its live interval; both writers persist but only latest receives",
      async () => {
        const interval = (await rows()).find((r) =>
          r.session_id === writer.id
        )!.interval;
        const { sent } = await send(writer.id, "relay_one", {
          chat_id: world!.room,
          text: `J3-S3-${crypto.randomUUID()}`,
        });
        assert(sent.message_id !== firstAnchor);
        assertEquals(
          (await rows()).find((r) =>
            r.session_id === writer.id && r.chat_id === world!.room
          )!.interval,
          interval,
        );
        const otherSend = await send(other.id, "relay_one", {
          chat_id: world!.room,
          text: `J3-both-${crypto.randomUUID()}`,
        });
        assertEquals(
          (await rows()).filter((r) => r.chat_id === world!.room).length,
          2,
        );
        assertEquals(
          (await rows()).filter((r) => r.chat_id === world!.room && r.recipient)
            .map((r) => r.session_id),
          [other.id],
        );
        await proof("S3", {
          session: writer.id,
          otherSession: other.id,
          room: world!.room,
          subscriptionInterval: interval,
          laterOutgoing: sent.message_id,
          otherAnchor: otherSend.sent.message_id,
        });
      },
    );
    await step(
      "S4 durable leave survives actual process restart; other writer stays active",
      async () => {
        const part = await turn(writer.id, "relay_one_room_leave", {
          chat_id: world!.room,
        });
        assertEquals(
          JSON.parse(part.state!.output!).structuredContent.subscribed,
          false,
        );
        await oc.stop();
        await oc.start();
        const list = await turn(writer.id, "relay_one_room_subscriptions", {});
        assertEquals(
          JSON.parse(list.state!.output!).structuredContent.subscriptions.find((
            r: { chat_id: number },
          ) => r.chat_id === world!.room).subscribed,
          false,
        );
        assertEquals(
          (await rows()).find((r) =>
            r.session_id === other.id && r.chat_id === world!.room
          )!.state,
          "active",
        );
        await proof("S4", {
          session: writer.id,
          room: world!.room,
          state: "left",
          restart: true,
          otherSession: other.id,
          otherState: "active",
        });
      },
    );
    await step(
      "S5 genuinely unwritable at plugin load prevents native send dispatch",
      async () => {
        await oc.stop();
        const blocked = `${oc.root}/unwritable`;
        await Deno.mkdir(blocked, { mode: 0o500 });
        assertEquals((await Deno.stat(blocked)).mode! & 0o777, 0o500);
        await assertRejects(
          () =>
            Deno.open(`${blocked}/control`, { createNew: true, write: true }),
          Deno.errors.PermissionDenied,
        );
        await oc.configure({
          plugin: [[bundle, {
            ...options,
            stateFile: `${blocked}/wake.sqlite`,
          }]],
        });
        await oc.start();
        const session = await oc.session("J3 unwritable at init");
        const text = `J3-S5-${crypto.randomUUID()}`;
        const before =
          (await world!.first.service.app.chats.messages(world!.room, {
            limit: 100,
          })).map((m) => m.id);
        const part = await turn(session.id, "relay_one_send_message", {
          chat_id: world!.room,
          text,
        });
        assertEquals(part.state?.status, "error");
        await assertRejects(
          () => Deno.stat(`${blocked}/wake.sqlite`),
          Deno.errors.NotFound,
        );
        await assertRejects(
          () => Deno.stat(`${blocked}/wake.sqlite-wal`),
          Deno.errors.NotFound,
        );
        assertEquals(
          (await world!.first.service.app.chats.messages(world!.room, {
            limit: 100,
          })).map((m) => m.id),
          before,
        );
        assertEquals(
          (await rows()).filter((r) => r.session_id === session.id),
          [],
        );
        await proof("S5", {
          session: session.id,
          room: world!.room,
          toolState: part.state!.status,
          remotePosts: 0,
          noDatabaseOrWal: true,
          mode: "0500",
          controlWrite: "PermissionDenied",
        });
        await oc.stop();
        await oc.configure({ plugin: [[bundle, options]] });
        await oc.start();
      },
    );
    await step(
      "S6 v1 experimental Code Mode leaves plugin proxies direct with native session context",
      async () => {
        await oc.stop();
        await oc.start("127.0.0.1", { OPENCODE_EXPERIMENTAL_CODE_MODE: "1" });
        const session = await oc.session("J3 code mode");
        const part = await turn(session.id, "twin_send_message", {
          chat_id: world!.room,
          text: `J3-S6-${crypto.randomUUID()}`,
        });
        assertEquals(part.state?.status, "completed");
        const result = JSON.parse(part.state!.output!);
        assertEquals(result.structuredContent.routing.session_id, session.id);
        assertEquals(result.structuredContent.routing.subscribed, true);
        assertStringIncludes(
          JSON.stringify(provider.requests.at(-1)),
          session.id,
        );
        const actual = (await rows()).filter((r) =>
          r.session_id === session.id
        );
        assertEquals(actual.length, 1);
        assertEquals(actual[0].chat_id, world!.room);
        await proof("S6", {
          session: session.id,
          room: world!.room,
          canonicalAlias: "twin",
          serverSubscription: actual[0],
          nativeContextAtConsumer: true,
          pluginToolsDirectOnV1: true,
          toolState: part.state!.status,
        });
        await oc.stop();
        await oc.start();
      },
    );
    await step(
      "S7 same-identity aliases dedup, distinct identity splits",
      async () => {
        const session = await oc.session("J3 aliases");
        const one = await send(session.id, "relay_one", {
          chat_id: world!.room,
          text: `J3-S7a-${crypto.randomUUID()}`,
        });
        const interval = (await rows()).find((r) =>
          r.session_id === session.id
        )!.interval;
        await send(session.id, "twin", {
          chat_id: world!.room,
          text: `J3-S7b-${crypto.randomUUID()}`,
        });
        assertEquals(
          (await rows()).filter((r) => r.session_id === session.id).length,
          1,
        );
        assertEquals(
          (await rows()).find((r) => r.session_id === session.id)!.interval,
          interval,
        );
        await send(session.id, "second", {
          chat_id: world!.secondRoom,
          text: `J3-S7c-${crypto.randomUUID()}`,
        });
        const actual = (await rows()).filter((r) =>
          r.session_id === session.id
        );
        assertEquals(actual.length, 2);
        assertEquals(new Set(actual.map((r) => r.relay)).size, 2);
        await proof("S7", {
          session: session.id,
          aliases: ["relay_one", "twin", "second"],
          rows: actual,
          acceptedFirstSendID: one.sent.message_id,
          boundary:
            "same identity/key/session shares a server membership interval",
        });
      },
    );
    await step("S8 actual isError send has no subscription", async () => {
      const session = await oc.session("J3 error");
      const part = await turn(session.id, "relay_one_send_message", {
        chat_id: 2147483647,
        text: "J3 invalid core chat",
      });
      assertEquals(part.state?.status, "completed");
      assertEquals(JSON.parse(part.state!.output!).isError, true);
      assertEquals(
        (await rows()).filter((r) => r.session_id === session.id),
        [],
      );
      await proof("S8", {
        session: session.id,
        toolState: part.state!.status,
        rows: 0,
      });
    });
    await step(
      "S9 OpenCode denied send has no subscription or remote post",
      async () => {
        await oc.stop();
        await oc.configure({
          permission: { "*": "allow", relay_one_send_message: "ask" },
        });
        await oc.start();
        const session = await oc.session("J3 permission denied");
        await poll(() =>
          world!.first.service.app.routing!.store.read().notices.every((n) =>
            n.state !== "attempting"
          )
        );
        const before =
          (await world!.first.service.app.chats.messages(world!.room)).map((
            m,
          ) => m.id);
        const providerBefore = provider.requests.length;
        provider.queue.push({
          tool: {
            name: "relay_one_send_message",
            args: {
              chat_id: world!.room,
              text: `J3-S9-${crypto.randomUUID()}`,
            },
          },
        });
        await oc.prompt(session.id, {
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "J3 test-owned denied send" }],
        });
        type Permission = { id: string; sessionID: string; permission: string };
        let request: Permission | undefined;
        await poll(async () => {
          request = (await oc.api<Permission[]>("/permission"))
            .find((p) => p.sessionID === session.id);
          return !!request;
        }, 10_000);
        assertEquals(request!.permission, "relay_one_send_message");
        await oc.api(`/permission/${request!.id}/reply`, "POST", {
          reply: "reject",
        });
        // Native processor.ts:200/647/694 stops after explicit rejection; it does
        // not request a model final. Observe the actual error and idle boundary.
        let part:
          | Awaited<ReturnType<typeof oc.messages>>[number]["parts"][number]
          | undefined;
        await poll(async () => {
          part = (await oc.messages(session.id)).flatMap((m) => m.parts)
            .find((p) => p.tool === "relay_one_send_message");
          const status = await oc.api<Record<string, { type: string }>>(
            "/session/status",
          );
          return part?.state?.status === "error" &&
            (!status[session.id] || status[session.id].type === "idle");
        }, 10_000);
        assert(part);
        assertStringIncludes(part.state!.error!, "rejected permission");
        assertEquals(provider.requests.length - providerBefore, 1);
        assertEquals(provider.queue, []);
        assertEquals(part.state?.status, "error");
        assertEquals(
          (await rows()).filter((r) => r.session_id === session.id),
          [],
        );
        assertEquals(
          (await world!.first.service.app.chats.messages(world!.room)).map((
            m,
          ) => m.id),
          before,
        );
        await proof("S9", {
          session: session.id,
          room: world!.room,
          toolState: part.state!.status,
          rows: 0,
          remoteMessageIDsUnchanged: true,
        });
      },
    );
    await step(
      "S3 live human around later outgoing is delivered exactly once;SELF never wakes",
      async () => {
        const live = await oc.session("S3 live owner boundaries");
        const room = (await world!.tool<{ chat_id: number }>(
          world!.first.client,
          "create_room",
          { name: "S3 live room", contact_ids: [world!.contact] },
        )).chat_id;
        const seed = `S3-live-seed-${crypto.randomUUID()}`;
        await send(live.id, "twin", { chat_id: room, text: seed });
        await world!.receives(seed);
        const before = provider.requests.length;
        const held = Promise.withResolvers<void>();
        const native = `msg_j3${crypto.randomUUID().replaceAll("-", "")}`;
        provider.queue.push(
          {
            tool: {
              name: "twin_send_message",
              args: {
                chat_id: room,
                text: `S3-later-SELF-${crypto.randomUUID()}`,
              },
            },
            hold: held.promise,
          },
          { text: "S3 native send completed" },
          { text: "S3 human answered exactly once" },
        );
        try {
          await oc.prompt(live.id, {
            messageID: native,
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "S3 held native send" }],
          });
          await poll(() => provider.requests.length === before + 1);
          const incoming = await world!.reply(
            `S3 live human ${crypto.randomUUID()}`,
            seed,
            room,
          );
          held.resolve();
          await oc.final(live.id, native);
          let wake: Awaited<ReturnType<typeof oc.messages>>[number] | undefined;
          await poll(async () => {
            wake = (await oc.messages(live.id)).find((m) =>
              m.parts.some((p) =>
                (p.metadata?.deltaChatWake as { chatId?: number } | undefined)
                  ?.chatId === room
              )
            );
            return !!wake;
          }, 30_000);
          assert(wake);
          await oc.final(live.id, wake.info.id);
          const wakes = (await oc.messages(live.id)).filter((m) =>
            m.parts.some((p) => p.metadata?.deltaChatWake)
          );
          assertEquals(wakes.length, 1);
          assertEquals(wakes[0].parts.length, 1);
          assertEquals(
            (wakes[0].parts[0].metadata!.deltaChatWake as {
              messageIds: number[];
            }).messageIds,
            [incoming.id],
          );
          assertStringIncludes(wakes[0].parts[0].text!, incoming.text);
          assertEquals(provider.requests.length - before, 3);
          await proof("S3-live", {
            session: live.id,
            room,
            humanID: incoming.id,
            nativeWake: wake.info.id,
            wakeMessages: 1,
            wakeParts: 1,
            providerWakeRequests: 1,
            selfWakes: 0,
            noSkippedHuman: true,
          });
        } finally {
          held.resolve();
        }
      },
    );
    // Resume is a J3 tool, although discontinuity production belongs to J4.
    await step(
      "J3 resume validates real existing core anchor and session ownership",
      async () => {
        // This adapter-contract scenario injects only the owning server's
        // blocked metadata. Actual anchor-loss production remains covered in J4.
        world!.first.service.app.routing!.store.write((metadata) => {
          metadata.rooms.find((r) => r.chat_id === world!.room)!.state =
            "blocked_discontinuity";
        });
        const invalid = await turn(other.id, "relay_one_room_resume", {
          chat_id: world!.room,
          after_id: 2147483647,
        });
        assertEquals(JSON.parse(invalid.state!.output!).isError, true);
        assertEquals(
          (await rows()).find((r) => r.session_id === other.id)!.state,
          "blocked_discontinuity",
        );
        const wrongChat = await turn(other.id, "relay_one_room_resume", {
          chat_id: world!.room,
          after_id: contactAnchor,
        });
        assertEquals(JSON.parse(wrongChat.state!.output!).isError, true);
        assertEquals(
          (await rows()).find((r) => r.session_id === other.id)!.state,
          "blocked_discontinuity",
        );
        const valid = await turn(other.id, "relay_one_room_resume", {
          chat_id: world!.room,
          after_id: firstAnchor,
        });
        const resumed = JSON.parse(valid.state!.output!).structuredContent;
        assertEquals(
          resumed.subscriptions.find((r: { chat_id: number }) =>
            r.chat_id === world!.room
          ).state,
          "active",
        );
        assertEquals(
          (await rows()).find((r) => r.session_id === other.id)!.state,
          "active",
        );
        await proof("J3-resume", {
          session: other.id,
          room: world!.room,
          anchor: firstAnchor,
          invalidRejected: true,
          wrongChatRejected: true,
          realCoreAnchorValidated: true,
        });
      },
    );
    assertEquals(provider.unexpected, []);
    assertEquals(provider.queue, []);
    await proof("J3-summary", {
      state: oc.root,
      unexpected: 0,
      scenarios: 9,
      extraResume: true,
      subscriptionsOnly: true,
    });
  } finally {
    await oc.close();
    await delay.close();
    await mcp.close();
    await provider.close();
    await world?.close();
  }
});
