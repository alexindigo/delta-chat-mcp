// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { deadline, poll } from "../../../../tests/support.ts";
import { openSqlite } from "../../sqlite.ts";
import { ProviderFixture } from "./provider_fixture.ts";
import { McpFixture } from "./mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./opencode_process.ts";
import { relayWorld } from "./relay_world.ts";

export async function mirrorWake(t: Deno.TestContext) {
  const provider = new ProviderFixture(),
    mcp = new McpFixture(),
    delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  let world: Awaited<ReturnType<typeof relayWorld>> | undefined;
  let wire: Awaited<ReturnType<typeof mirrorWire>> | undefined;
  const releases: (() => void)[] = [];
  const state = `${oc.root}/wake-state/wake.sqlite`;
  const query = async (sql: string, ...args: (string | number)[]) => {
    const db = await openSqlite(state, true);
    try {
      return db.all(sql, ...args);
    } finally {
      db.close();
    }
  };
  const proof = async (scenario: string, facts: Record<string, unknown>) => {
    const row = {
      time: new Date().toISOString(),
      version: await oc.version(),
      scenario,
      ...facts,
    };
    await Deno.writeTextFile(
      `${oc.root}/j5-facts.jsonl`,
      JSON.stringify(row) + "\n",
      { append: true, mode: 0o600 },
    );
    console.log(JSON.stringify(row));
  };
  const step = async (name: string, run: () => Promise<void>) => {
    if (!await t.step(name, run)) {
      throw new Error(`J5 ${name} failed; preserved ${oc.root}`);
    }
  };
  try {
    world = await relayWorld();
    wire = mirrorWire(world.first.config.url);
    const options = (enabled: boolean) => ({
      relays: {
        relay: {
          url: wire!.url,
          headers: world!.first.config.headers,
          enabled,
        },
      },
      stateFile: state,
    });
    const pluginURL =
      new URL("../../dist/delta-chat-mcp-opencode.js", import.meta.url).href;
    await oc.configure({
      plugin: [[
        pluginURL,
        options(true),
      ]],
      mcp: {},
    });
    await oc.start();
    const session = await oc.session("J5 native final peer consumer");
    const seed = `J5 seed ${crypto.randomUUID()}`;
    provider.queue.push({
      tool: {
        name: "relay_send_message",
        args: { chat_id: world.room, text: seed },
      },
    }, { text: "J5 subscribed native final" });
    const native = `msg_j5${crypto.randomUUID().replaceAll("-", "")}`;
    await oc.prompt(session.id, {
      messageID: native,
      agent: "selected",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: "Subscribe using the real relay." }],
    });
    await oc.final(session.id, native);
    await world.receives(seed);
    const nativeID = () => `msg_j5${crypto.randomUUID().replaceAll("-", "")}`;
    const prompt = async (id: string, text: string, target = session.id) => {
      await oc.prompt(target, {
        messageID: id,
        agent: "selected",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text }],
      });
      return await oc.final(target, id);
    };
    const posts = async (text?: string) =>
      (await world!.first.service.app.chats.messages(world!.room, {
        limit: 100,
      })).filter((m) => m.fromSelf && (text === undefined || m.text === text));
    const delivery = async (incoming: number, desired?: string) => {
      let d: Record<string, unknown> | undefined;
      await poll(async () => {
        d =
          (await query("SELECT * FROM delivery WHERE session_id=?", session.id))
            .find((r) =>
              (JSON.parse(String(r.message_ids)) as number[]).includes(incoming)
            );
        return !!d && (!desired || d.state === desired);
      }, 30_000);
      return d!;
    };
    const wakeFor = async (incoming: number, target = session.id) => {
      let wake: Awaited<ReturnType<typeof oc.messages>>[number] | undefined;
      await poll(async () => {
        wake = (await oc.messages(target)).find((m) =>
          m.parts.some((p) =>
            (p.metadata?.deltaChatWake as { messageIds: number[] } | undefined)
              ?.messageIds.includes(incoming)
          )
        );
        return !!wake;
      }, 30_000);
      return wake!;
    };
    await step(
      "S22 actual native final exactly once in transcript and encrypted stock peer",
      async () => {
        const before = provider.requests.length;
        const answer =
          `S22 exact native answer ${crypto.randomUUID()}\n\nSecond paragraph & < > α.`;
        provider.queue.push({ text: answer });
        const incoming = await world!.reply(
          `S22 incoming ${crypto.randomUUID()}`,
          seed,
        );
        let wake: Awaited<ReturnType<typeof oc.messages>>[number] | undefined;
        await poll(async () => {
          wake = (await oc.messages(session.id)).find((m) =>
            m.parts.some((p) =>
              (p.metadata?.deltaChatWake as
                | { messageIds: number[] }
                | undefined)?.messageIds.includes(incoming.id)
            )
          );
          return !!wake;
        }, 30_000);
        assert(wake);
        const final = await oc.final(session.id, wake.info.id);
        assertEquals(
          final.parts.filter((p) => p.type === "text").map((p) => p.text).join(
            "\n\n",
          ),
          answer,
        );
        const received = await world!.receivesComplete(answer);
        let d: Record<string, unknown> | undefined;
        await poll(async () => {
          d = (await query(
            "SELECT * FROM delivery WHERE session_id=?",
            session.id,
          )).find((r) =>
            String(r.message_ids) === JSON.stringify([incoming.id])
          );
          return d?.state === "mirrored";
        }, 15_000);
        const posts =
          (await world!.first.service.app.chats.messages(world!.room, {
            limit: 100,
          })).filter((m) => m.fromSelf && m.text === answer);
        assertEquals(posts.length, 1);
        assertEquals(JSON.parse(String(d!.mirror_message_ids)), [posts[0].id]);
        assertEquals(provider.requests.length - before, 1);
        await proof("S22", {
          sessionID: session.id,
          room: world!.room,
          incomingID: incoming.id,
          nativeWakeID: wake.info.id,
          nativeAnswerID: final.info.id,
          roomPostID: posts[0].id,
          peerMessageID: received.id,
          encrypted: received.showPadlock,
          exactCompletePeerBody: received.body === answer,
          roomPosts: 1,
          providerRequests: 1,
          transcriptRetained: true,
          state: oc.root,
        });
      },
    );
    await step(
      "S22b main-channel manual handoff posts once without automatic broadcast",
      async () => {
        const answer = `S22b native manual handoff ${crypto.randomUUID()}`;
        const before = provider.requests.length;
        const deliveriesBefore =
          (await query("SELECT id FROM delivery")).length;
        provider.queue.push({
          tool: {
            name: "relay_send_message",
            args: { chat_id: world!.room, text: answer },
          },
        }, { text: answer });
        const final = await prompt(
          nativeID(),
          "Send the main-channel substantive handoff.",
        );
        const received = await world!.receivesComplete(answer);
        assertEquals((await posts(answer)).length, 1);
        assertEquals(
          (await query("SELECT id FROM delivery")).length,
          deliveriesBefore,
        );
        assertEquals(provider.requests.length - before, 2);
        await proof("S22b", {
          sessionID: session.id,
          nativeAnswerID: final.info.id,
          peerMessageID: received.id,
          roomPosts: 1,
          autoBroadcasts: 0,
          nativeTranscript: true,
        });
      },
    );
    await step(
      "S23 incoming6200 and final7000 exact complete encrypted peer body and readback",
      async () => {
        const make = (length: number, name: string) => {
          const end = `END-${name}-${crypto.randomUUID()}`;
          return (`${name} & < > \" ' α\n\nhttps://example.invalid/a\n`.repeat(
            length,
          )).slice(0, length - end.length) + end;
        };
        const incomingText = make(6200, "S23-input"),
          answer = make(7000, "S23-answer");
        provider.queue.push({ text: answer });
        const incoming = await world!.reply(incomingText, seed);
        const wake = await wakeFor(incoming.id);
        assert(wake.parts[0].text!.includes(incomingText));
        const final = await oc.final(session.id, wake.info.id);
        assertEquals(
          final.parts.filter((p) => p.type === "text").map((p) => p.text).join(
            "\n\n",
          ),
          answer,
        );
        const peer = await world!.receivesComplete(answer);
        await delivery(incoming.id, "mirrored");
        const result = await world!.tool<
          {
            messages: {
              id: number;
              fromSelf: boolean;
              text: string;
              textComplete: boolean;
            }[];
          }
        >(world!.first.client, "read_messages", {
          chat_id: world!.room,
          after_id: incoming.id,
          limit: 100,
        });
        const copies = result.messages.filter((m) =>
          m.fromSelf && m.text === answer
        );
        assertEquals(copies.length, 1);
        assertEquals(copies[0].textComplete, true);
        assertEquals(peer.body.length, 7000);
        await proof("S23", {
          incomingLength: incomingText.length,
          finalLength: answer.length,
          exactNativeInput: true,
          nativeAnswerID: final.info.id,
          peerMessageID: peer.id,
          encrypted: peer.showPadlock,
          completePeerBody: true,
          endMarkerAtPeer: peer.body.endsWith(answer.slice(-48)),
          exactMCPReadback: true,
          roomPosts: 1,
        });
      },
    );
    await step(
      "S24 exact self model final suppresses runtime, deliberate progress preserved with reused callIDs",
      async () => {
        const answer = `S24 exact final ${crypto.randomUUID()}`,
          progress = `S24 deliberate progress ${crypto.randomUUID()}`;
        const before = provider.requests.length;
        provider.queue.push({
          tool: {
            name: "relay_send_message",
            args: { chat_id: world!.room, text: progress },
          },
        }, {
          tool: {
            name: "relay_send_message",
            args: { chat_id: world!.room, text: answer },
          },
        }, { text: answer });
        const incoming = await world!.reply(
          `S24 incoming ${crypto.randomUUID()}`,
          seed,
        );
        const wake = await wakeFor(incoming.id);
        const final = await oc.final(session.id, wake.info.id);
        const d = await delivery(incoming.id, "answered_by_model");
        const peer = await world!.receivesComplete(answer);
        await world!.receivesComplete(progress);
        assertEquals((await posts(answer)).length, 1);
        assertEquals((await posts(progress)).length, 1);
        const evidence = await query(
          "SELECT native_message_id,native_part_id,call_id,core_id FROM model_send WHERE delivery_id=?",
          String(d.id),
        );
        assertEquals(evidence.length, 2);
        assertEquals(new Set(evidence.map((r) => r.call_id)).size, 1);
        assertEquals(new Set(evidence.map((r) => r.native_message_id)).size, 2);
        assertEquals(provider.requests.length - before, 3);
        await proof("S24", {
          nativeAnswerID: final.info.id,
          peerMessageID: peer.id,
          state: d.state,
          finalPosts: 1,
          deliberateProgressPosts: 1,
          reusedCallIDScopedByNativeMessage: true,
          observedCoreIDs: evidence.map((r) => r.core_id),
        });
      },
    );
    await step(
      "J5 latest-recipient transfers preserve subscribers and identical finals are not suppressed across sessions",
      async () => {
        const other = await oc.session("J5 other writer identical answer");
        const otherSeed = `J5 other seed ${crypto.randomUUID()}`;
        provider.queue.push({
          tool: {
            name: "relay_send_message",
            args: { chat_id: world!.room, text: otherSeed },
          },
        }, { text: "Other subscribed" });
        await prompt(nativeID(), "Other writer subscribes", other.id);
        await world!.receivesComplete(otherSeed);
        const answer = `J5 both writers identical ${crypto.randomUUID()}`;
        const before = provider.requests.length;
        provider.queue.push({ text: answer });
        const incoming = await world!.reply(
          `J5 both incoming ${crypto.randomUUID()}`,
          seed,
        );
        const otherWake = await wakeFor(incoming.id, other.id);
        await oc.final(other.id, otherWake.info.id);
        await world!.receivesComplete(answer);
        await poll(async () => (await posts(answer)).length === 1, 15_000);
        assert(
          !(await oc.messages(session.id)).some((m) =>
            m.parts.some((p) =>
              (p.metadata?.deltaChatWake as
                | { messageIds: number[] }
                | undefined)?.messageIds.includes(incoming.id)
            )
          ),
        );
        assertEquals(provider.requests.length - before, 1);
        provider.queue.push({
          tool: {
            name: "relay_room_leave",
            args: { chat_id: world!.room },
          },
        }, { text: "Other explicitly left" });
        await prompt(nativeID(), "Other writer explicit leave", other.id);
        provider.queue.push({ text: answer });
        const transferred = await world!.reply(
          `J5 restored older subscriber ${crypto.randomUUID()}`,
          seed,
        );
        const firstWake = await wakeFor(transferred.id);
        await oc.final(session.id, firstWake.info.id);
        await poll(async () => (await posts(answer)).length === 2, 15_000);
        assert(
          !(await oc.messages(other.id)).some((m) =>
            m.parts.some((p) =>
              (p.metadata?.deltaChatWake as
                | { messageIds: number[] }
                | undefined)?.messageIds.includes(transferred.id)
            )
          ),
        );
        assertEquals(provider.requests.length - before, 4);
        await proof("J5-both-identical", {
          sessions: [session.id, other.id],
          incomingIDs: [incoming.id, transferred.id],
          roomPosts: 2,
          providerWakeRequests: 2,
          otherExplicitLeave: true,
        });
      },
    );
    await step(
      "J5 accepted mirror transport held for A cannot block same-session native wake and peer receipt for B",
      async () => {
        const otherRoom = (await world!.tool<{ chat_id: number }>(
          world!.first.client,
          "create_room",
          {
            name: "J5 independent transport room",
            contact_ids: [world!.contact],
          },
        )).chat_id;
        const otherSeed = `J5 independent room seed ${crypto.randomUUID()}`;
        provider.queue.push({
          tool: {
            name: "relay_send_message",
            args: { chat_id: otherRoom, text: otherSeed },
          },
        }, { text: "Other room subscribed" });
        await prompt(
          nativeID(),
          "Subscribe another room on this same session.",
        );
        await world!.receivesComplete(otherSeed);
        const a = `J5 held A final ${crypto.randomUUID()}`,
          b = `J5 independent B final ${crypto.randomUUID()}`;
        wire!.holdNext = true;
        provider.queue.push({ text: a });
        const incomingA = await world!.reply(
          `J5 hold A ${crypto.randomUUID()}`,
          seed,
        );
        await poll(() => wire!.holding, 15_000);
        await world!.receivesComplete(a);
        assertEquals((await delivery(incomingA.id)).state, "mirroring");
        provider.queue.push({ text: b });
        const incomingB = await world!.reply(
          `J5 independent B ${crypto.randomUUID()}`,
          otherSeed,
          otherRoom,
        );
        const wakeB = await wakeFor(incomingB.id);
        const finalB = await oc.final(session.id, wakeB.info.id);
        const peerB = await world!.receivesComplete(b);
        await delivery(incomingB.id, "mirrored");
        assertEquals(wire!.holding, true);
        assertEquals((await delivery(incomingA.id)).state, "mirroring");
        wire!.release();
        await delivery(incomingA.id, "mirrored");
        await proof("J5-independent-mirror", {
          sameSession: session.id,
          roomA: world!.room,
          roomB: otherRoom,
          nativeAnswerB: finalB.info.id,
          peerMessageB: peerB.id,
          BReceivedWhileATransportHeld: true,
          roomPostsA: 1,
          roomPostsB: 1,
        });
      },
    );
    for (const scenario of ["S25", "S26", "S27"]) {
      await step(
        `${scenario} abort/modelHTTP400/empty final creates no post or retry`,
        async () => {
          const before = provider.requests.length,
            beforePosts = (await posts()).map((p) => p.id);
          const held = Promise.withResolvers<void>();
          releases.push(held.resolve);
          provider.queue.push(
            scenario === "S25"
              ? { text: "aborted must not post", hold: held.promise }
              : scenario === "S26"
              ? { status: 400 }
              : { text: "" },
          );
          const incoming = await world!.reply(
            `${scenario} incoming ${crypto.randomUUID()}`,
            seed,
          );
          const wake = await wakeFor(incoming.id);
          if (scenario === "S25") {
            await poll(() => provider.requests.length === before + 1);
            await oc.api(`/session/${session.id}/abort`, "POST");
            held.resolve();
          }
          const expected = scenario === "S25"
            ? "aborted"
            : scenario === "S26"
            ? "failed"
            : "empty";
          const d = await delivery(incoming.id, expected);
          assertEquals((await posts()).map((p) => p.id), beforePosts);
          assertEquals(d.continuations, 0);
          assertEquals(provider.requests.length - before, 1);
          await proof(scenario, {
            state: d.state,
            nativeWakeID: wake.info.id,
            roomPosts: 0,
            retries: 0,
            providerRequests: 1,
            actualProviderHTTP: scenario === "S26" ? 400 : undefined,
          });
        },
      );
    }
    await step(
      "J5 plugin-owned pause/reload retains pending native answer; resume posts once without a model turn",
      async () => {
        const before = provider.requests.length;
        const held = Promise.withResolvers<void>();
        releases.push(held.resolve);
        const answer = `J5 paused native final ${crypto.randomUUID()}`;
        provider.queue.push({
          text: answer,
          hold: held.promise,
          holdSilent: true,
        });
        const incoming = await world!.reply(
          `J5 pause incoming ${crypto.randomUUID()}`,
          seed,
        );
        const wake = await wakeFor(incoming.id);
        await poll(() => provider.requests.length === before + 1);
        // Hold posting at this fixture's exact pre-dispatch gate until
        // the native final is durable, then reload with plugin enabled:false.
        wire!.rejectMirror = true;
        const rejected = wire!.rejected;
        held.resolve();
        const final = await oc.final(session.id, wake.info.id);
        await poll(async () =>
          (await query("SELECT answer_id FROM native_execution")).some((r) =>
            r.answer_id === final.info.id
          )
        );
        await poll(() => wire!.rejected > rejected);
        await delivery(incoming.id, "admitted");
        await oc.api("/instance/dispose", "POST");
        await oc.stop();
        await oc.configure({ plugin: [[pluginURL, options(false)]] });
        await oc.start();
        await oc.api("/session/status");
        assertEquals((await posts(answer)).length, 0);
        const d = await delivery(incoming.id);
        assertEquals(d.state, "admitted");
        assert(
          (await oc.messages(session.id)).some((m) =>
            m.info.id === final.info.id
          ),
        );
        wire!.rejectMirror = false;
        await oc.api("/instance/dispose", "POST");
        await oc.stop();
        await oc.configure({ plugin: [[pluginURL, options(true)]] });
        await oc.start();
        await oc.api("/session/status");
        await delivery(incoming.id, "mirrored");
        const peer = await world!.receivesComplete(answer);
        assertEquals((await posts(answer)).length, 1);
        assertEquals(provider.requests.length - before, 1);
        await proof("J5-disable-mirror", {
          nativeAnswerID: final.info.id,
          pausedPosts: 0,
          reenabledPosts: 1,
          peerMessageID: peer.id,
          intendedNativeAnswerRetained: true,
        });
      },
    );
    await step(
      "S29 warm relay down before mirror cold refusal recovers to one actual post",
      async () => {
        const before = provider.requests.length;
        const held = Promise.withResolvers<void>();
        releases.push(held.resolve);
        const answer = `S29 recovered final ${crypto.randomUUID()}`;
        provider.queue.push({
          text: answer,
          hold: held.promise,
          holdSilent: true,
        });
        const incoming = await world!.reply(
          `S29 incoming ${crypto.randomUUID()}`,
          seed,
        );
        const wake = await wakeFor(incoming.id);
        await poll(() => provider.requests.length === before + 1);
        const calls = wire!.sends;
        await wire!.stop();
        held.resolve();
        const final = await oc.final(session.id, wake.info.id);
        await poll(async () =>
          (await query("SELECT answer_id FROM native_execution")).some((r) =>
            r.answer_id === final.info.id
          )
        );
        assertEquals((await posts(answer)).length, 0);
        assertEquals(wire!.sends, calls);
        wire!.restart();
        const d = await delivery(incoming.id, "mirrored");
        const peer = await world!.receivesComplete(answer);
        assertEquals((await posts(answer)).length, 1);
        assertEquals(wire!.sends - calls, 1);
        await proof("S29", {
          state: d.state,
          warmPoolBeforeOutage: true,
          forwardedWhileDown: 0,
          acceptedPosts: 1,
          peerMessageID: peer.id,
          nativeAnswerID: final.info.id,
          exactCompletePeerBody: true,
        });
      },
    );
    await step(
      "S29b actual forwarded send response loss is uncertain, never resent after dispose/reinit",
      async () => {
        const events = await oc.events();
        try {
          const answer = `S29b uncertain native final ${crypto.randomUUID()}`;
          wire!.dropNext = true;
          const sends = wire!.sends;
          provider.queue.push({ text: answer });
          const incoming = await world!.reply(
            `S29b incoming ${crypto.randomUUID()}`,
            seed,
          );
          const wake = await wakeFor(incoming.id);
          const final = await oc.final(session.id, wake.info.id);
          const peer = await world!.receivesComplete(answer);
          const d = await delivery(incoming.id, "mirror_uncertain");
          await poll(
            () =>
              events.rows.some((e) =>
                e.payload?.type === "tui.toast.show" &&
                String(e.payload.properties?.message).includes(String(d.id))
              ),
            15_000,
          );
          await oc.api("/instance/dispose", "POST");
          await oc.api("/session/status");
          const inspect = nativeID();
          const router = world!.first.service.app.routing!;
          const owner = String(world!.first.service.app.apiKeys.list()[0].id);
          await poll(() =>
            router.inbox(owner).deliveries.some((row) =>
              row.delivery_id === d.id && row.outcome === "mirror_uncertain"
            )
          );
          provider.queue.push({
            tool: { name: "relay_room_subscriptions", args: {} },
          }, { text: "Uncertain inspected explicitly" });
          await prompt(inspect, "Inspect uncertain routing state only.");
          const part = (await oc.messages(session.id)).flatMap((m) => m.parts)
            .findLast((p) => p.tool === "relay_room_subscriptions");
          assert(part?.state?.output?.includes("mirror_uncertain"));
          assert(
            (await oc.messages(session.id)).some((m) =>
              m.info.id === final.info.id
            ),
          );
          assertEquals(wire!.sends - sends, 1);
          assertEquals(wire!.dropped, 1);
          assertEquals((await posts(answer)).length, 1);
          assertEquals(JSON.parse(String(d.mirror_message_ids)), []);
          await proof("S29b", {
            nativeAnswerID: final.info.id,
            peerMessageID: peer.id,
            forwardedActualSends: 1,
            roomPosts: 1,
            droppedResponses: 1,
            state: d.state,
            noAutomaticResendAfterReinit: true,
            durableStateAtListConsumer: true,
            supportedNativeToastObserved: true,
            intendedNativeAnswerRetained: true,
            nativeHealthUserRows: (await oc.messages(session.id)).filter((m) =>
              m.parts.some((p) =>
                p.metadata?.deltaChatNotice
              )
            ).length,
          });
        } finally {
          await events.close();
        }
      },
    );
    await step(
      "S28 real C19 forced auto-compaction preserves room lineage and excludes internal summary",
      async () => {
        // Cleanly join consumers and release this instance's lease before the
        // process/config change; SIGTERM alone is not that native barrier.
        await oc.api("/instance/dispose", "POST");
        await poll(
          async () =>
            (await query(
              "SELECT session_id FROM lease WHERE session_id=?",
              session.id,
            )).length === 0,
          10_000,
        );
        await oc.stop();
        await oc.configure({
          ...provider.config(256),
          compaction: {
            auto: true,
            reserved: 0,
            tail_turns: 0,
            preserve_recent_tokens: 0,
          },
        });
        await oc.start();
        const before = provider.requests.length;
        const summary = `S28 INTERNAL summary ${crypto.randomUUID()}`,
          answer =
            `S28 exact room final ${crypto.randomUUID()}\n\nAfter real compaction.`;
        // C19's usage overflow is emitted by the room wake's own non-final
        // tool step, with the complete compaction script queued beforehand.
        // processor.ts:491–495,693 and prompt.ts:1320–1327 create an auto
        // compaction (not source replay) after this finished tool-calls step.
        provider.queue.push(
          {
            tool: { name: "relay_status", args: {} },
            usage: 300,
          },
          { text: summary, usage: 5 },
          {
            text: answer,
            usage: 5,
          },
        );
        const incoming = await world!.reply(
          `S28 incoming ${crypto.randomUUID()}`,
          seed,
        );
        const wake = await wakeFor(incoming.id);
        const d = await delivery(incoming.id, "mirrored");
        const rows = await oc.messages(session.id);
        const after = rows.slice(
          rows.findIndex((m) => m.info.id === wake.info.id) + 1,
        );
        const overflowStep = after.find((m) =>
          m.info.role === "assistant" && m.info.parentID === wake.info.id &&
          m.parts.some((p) =>
            p.tool === "relay_status" && p.state?.status === "completed"
          )
        );
        assert(overflowStep);
        assertEquals(overflowStep.info.finish, "tool-calls");
        const compactions = after.filter((m) =>
          m.parts.some((p) => p.type === "compaction")
        );
        assertEquals(compactions.length, 1);
        const compact = compactions[0];
        const internal = after.find((m) => m.info.agent === "compaction");
        const continuation = after.find((m) =>
          m.info.role === "user" && m.parts.length > 0 &&
          m.parts.every((p) =>
            p.synthetic && p.metadata?.compaction_continue === true
          )
        );
        assert(compact && internal && continuation);
        assertEquals(internal.info.parentID, compact.info.id);
        const final = after.find((m) =>
          m.info.role === "assistant" &&
          m.info.parentID === continuation.info.id
        );
        assert(final);
        assertEquals(
          final.parts.filter((p) => p.type === "text").map((p) => p.text).join(
            "\n\n",
          ),
          answer,
        );
        assertEquals(
          (await query(
            "SELECT answer_id FROM native_execution WHERE delivery_id=?",
            String(d.id),
          ))[0].answer_id,
          final.info.id,
        );
        const peer = await world!.receivesComplete(answer);
        assertEquals((await posts(answer)).length, 1);
        assertEquals((await posts(summary)).length, 0);
        assertEquals(d.user_message_id, wake.info.id);
        assertEquals(d.chat_id, world!.room);
        assertEquals(provider.requests.length - before, 3);
        await proof("S28", {
          incomingID: incoming.id,
          wakeID: wake.info.id,
          roomOverflowToolStepID: overflowStep.info.id,
          compactionID: compact.info.id,
          summaryID: internal.info.id,
          syntheticContinuationID: continuation.info.id,
          nativeAnswerID: final.info.id,
          peerMessageID: peer.id,
          exactCompletePeerBody: true,
          roomPosts: 1,
          internalSummaryPosts: 0,
          actualCompactions: compactions.length,
          providerRequests: 3,
          cleanLeaseBarrier: true,
          retainedOriginalRoom: d.chat_id === world!.room,
        });
      },
    );
    assertEquals(provider.unexpected, []);
    assertEquals(provider.queue, []);
  } finally {
    for (const release of releases) release();
    await oc.close();
    await delay.close();
    await mcp.close();
    await provider.close();
    await wire?.close();
    await world?.close();
  }
}

/** Owned fault wire: the upstream is the actual protected relay/core, never a
 * fake consumer. No payload bodies/credentials are logged. */
function mirrorWire(upstream: string) {
  let http: Deno.HttpServer<Deno.NetAddr> | undefined;
  let port = 0;
  const control = {
    sends: 0,
    dropped: 0,
    dropNext: false,
    rejectMirror: false,
    rejected: 0,
  };
  let holdNext = false;
  let hold: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let lifetime: AbortController;
  const start = () => {
    lifetime = new AbortController();
    http = Deno.serve({
      hostname: "127.0.0.1",
      port,
      signal: lifetime.signal,
      onListen() {},
      onError: () => new Response(null, { status: 500 }),
    }, async (request) => {
      const body = request.method === "POST"
        ? await request.clone().json().catch(() => undefined)
        : undefined;
      if (
        body?.method === "tools/call" && body.params?.name === "inbox_mirror" &&
        control.rejectMirror
      ) {
        control.rejected++;
        return Response.json({ error: "Service closing" }, { status: 503 });
      }
      const response = await fetch(new Request(upstream, request));
      if (
        body?.method === "tools/call" && body.params?.name === "inbox_mirror"
      ) {
        control.sends++;
        if (holdNext) {
          holdNext = false;
          const bytes = await response.arrayBuffer();
          hold = Promise.withResolvers<void>();
          await hold.promise;
          hold = undefined;
          return new Response(bytes, {
            status: response.status,
            headers: response.headers,
          });
        }
        if (control.dropNext) {
          control.dropNext = false;
          await response.arrayBuffer();
          control.dropped++;
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("event: message\ndata: "));
                setTimeout(
                  () => c.error(new Error("j5-owned-response-loss")),
                  20,
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
      }
      return response;
    });
    port = http.addr.port;
  };
  start();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get sends() {
      return control.sends;
    },
    get dropped() {
      return control.dropped;
    },
    get rejected() {
      return control.rejected;
    },
    set rejectMirror(value: boolean) {
      control.rejectMirror = value;
    },
    set dropNext(value: boolean) {
      control.dropNext = value;
    },
    set holdNext(value: boolean) {
      holdNext = value;
    },
    get holding() {
      return !!hold;
    },
    release() {
      hold?.resolve();
    },
    async stop() {
      if (http) {
        const stopped = http;
        http = undefined;
        // This outage fixture closes its own listener AND native MCP event
        // streams. shutdown() is graceful and cannot end an unbounded GET SSE.
        lifetime.abort();
        await deadline(stopped.finished, 15_000);
      }
    },
    restart() {
      assert(!http);
      start();
    },
    async close() {
      hold?.resolve();
      if (http) {
        lifetime.abort();
        await deadline(http.finished, 15_000);
      }
    },
  };
}
