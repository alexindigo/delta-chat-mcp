// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { poll } from "../../../../tests/support.ts";
import { openSqlite } from "../../sqlite.ts";
import { ProviderFixture } from "./provider_fixture.ts";
import { McpFixture } from "./mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./opencode_process.ts";
import { relayWorld } from "./relay_world.ts";
import { remainingWake } from "./j4_remaining.ts";

export async function nativeWake(t: Deno.TestContext) {
  const provider = new ProviderFixture(),
    mcp = new McpFixture(),
    delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  let world: Awaited<ReturnType<typeof relayWorld>> | undefined;
  const state = `${oc.root}/wake-state/wake.sqlite`;
  const observerLog = `${oc.root}/owned-relay-counts.json`;
  const observerURL =
    new URL("../fixtures/wake-observer-plugin.ts", import.meta.url).href;
  const ownedSnapshot = async () =>
    JSON.parse(await Deno.readTextFile(observerLog)) as {
      epoch: string;
      relays: {
        alias: string;
        connections: number;
        connecting: number;
        cleanupFailures: number;
        enabled: boolean;
      }[];
    };
  const pluginOptions = (enabled: boolean | Record<string, boolean>) => ({
    relays: Object.fromEntries(["relay", "twin"].map((alias) => [alias, {
      url: world!.first.config.url,
      headers: world!.first.config.headers,
      enabled: typeof enabled === "boolean" ? enabled : enabled[alias],
    }])),
    stateFile: state,
    observerLog,
  });
  const releases: (() => void)[] = [];
  const nativeIDs = () => `msg_j4${crypto.randomUUID().replaceAll("-", "")}`;
  const wakeRows = async () =>
    (await oc.messages(sessionID)).filter((row) =>
      row.parts.some((p) => p.metadata?.deltaChatWake)
    );
  let sessionID = "";
  const query = async (sql: string, ...args: (string | number | null)[]) => {
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
      `${oc.root}/j4-facts.jsonl`,
      JSON.stringify(row) + "\n",
      { append: true, mode: 0o600 },
    );
    console.log(JSON.stringify(row));
  };
  try {
    world = await relayWorld({ partialDownloads: true });
    const listenerBaseline = world.first.service.app.events.listenerCount;
    const profile = provider.config();
    const variants = profile.provider.test.models["test-model"]
      .variants as Record<string, unknown>;
    variants.careful = { reasoningEffort: "high" };
    await oc.configure({
      ...profile,
      agent: {
        selected: {
          mode: "primary",
          model: "test/test-model",
          variant: "careful",
          description: "J4 selected primary",
        },
      },
      plugin: [[
        observerURL,
        pluginOptions(true),
      ]],
      mcp: {
        fixture: {
          type: "remote",
          url: mcp.url,
          oauth: false,
          headers: { Authorization: `Bearer ${mcp.token}` },
          enabled: true,
        },
      },
    });
    await oc.start();
    const session = await oc.session("J4 native wake consumer");
    sessionID = session.id;
    const seed = `J4-subscribe-${crypto.randomUUID()}`;
    provider.queue.push({
      tool: {
        name: "relay_send_message",
        args: { chat_id: world.room, text: seed },
      },
    }, { text: "Subscribed native answer" });
    const initial = `msg_j4${crypto.randomUUID().replaceAll("-", "")}`;
    await oc.prompt(session.id, {
      messageID: initial,
      agent: "selected",
      variant: "default",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{
        type: "text",
        text: "Subscribe this session by sending the fixture text.",
      }],
    });
    await oc.final(session.id, initial);
    await world.receives(seed);
    const step = async (name: string, run: () => Promise<void>) => {
      if (!await t.step(name, run)) {
        throw new Error(`J4 ${name} failed; preserved ${oc.root}`);
      }
    };
    await step(
      "S10 early same idle session native wake reaches actual consumer",
      async () => {
        const before = provider.requests.length;
        const marker =
          `J4 incoming operator text ${crypto.randomUUID()} & < > α\nlast line`;
        const answer = `J4 native answer ${crypto.randomUUID()}`;
        provider.queue.push({ text: answer });
        const incoming = await world!.reply(marker, seed);
        let wake: Awaited<ReturnType<typeof oc.messages>>[number] | undefined;
        await poll(async () => {
          wake = (await oc.messages(session.id)).find((row) =>
            row.parts.some((p) => p.metadata?.deltaChatWake)
          );
          return !!wake;
        }, 30_000);
        assert(wake);
        const final = await oc.final(session.id, wake.info.id);
        assertStringIncludes(
          final.parts.filter((p) => p.type === "text").map((p) => p.text).join(
            "",
          ),
          answer,
        );
        assertEquals(provider.requests.length - before, 1);
        const wire = JSON.stringify(provider.requests[before]);
        assertStringIncludes(wire, marker.replaceAll("\n", "\\n"));
        const rows = await oc.messages(session.id);
        const wakes = rows.filter((r) =>
          r.parts.some((p) => p.metadata?.deltaChatWake)
        );
        assertEquals(wakes.length, 1);
        assertEquals(wakes[0].parts.length, 1);
        const part = wakes[0].parts[0];
        assertEquals(part.type, "text");
        assertStringIncludes(part.text!, marker);
        assertStringIncludes(part.text!, incoming.fromName);
        assertStringIncludes(part.text!, incoming.fromAddress);
        assert(
          !part.text!.includes("not an instruction from the OpenCode operator"),
        );
        assertEquals(
          (part.metadata!.deltaChatWake as { messageIds: number[] }).messageIds,
          [incoming.id],
        );
        assertEquals(
          rows.flatMap((r) => r.parts).filter((p) =>
            p.tool?.endsWith("wait_for_messages")
          ).length,
          0,
        );
        const info = await oc.api(`/session/${session.id}`);
        assertEquals(info.agent, "selected");
        assertEquals(info.model, {
          providerID: "test",
          id: "test-model",
          variant: "default",
        });
        await poll(async () => {
          const db = await openSqlite(state, true);
          try {
            return db.all("SELECT answer_id FROM native_execution").some((
              row,
            ) => row.answer_id === final.info.id);
          } finally {
            db.close();
          }
        }, 10_000);
        await proof("S10", {
          sessionID: session.id,
          room: world!.room,
          incomingID: incoming.id,
          canonicalSender: incoming.fromAddress,
          userMessageID: wake.info.id,
          partID: part.id,
          nativeAnswerID: final.info.id,
          providerRequests: 1,
          wakeMessages: 1,
          wakeParts: 1,
          nativeWaitToolCalls: 0,
          exactBodyAtConsumer: true,
          state: oc.root,
        });
      },
    );
    const busyBatch = async (count: number, scenario: string) => {
      const before = provider.requests.length;
      const previous = (await wakeRows()).length;
      const latch = Promise.withResolvers<void>();
      releases.push(latch.resolve);
      const native = nativeIDs();
      const answer = `${scenario} queued batch native answer`;
      provider.queue.push({
        text: `${scenario} held operator answer`,
        hold: latch.promise,
      }, { text: answer });
      await oc.prompt(sessionID, {
        messageID: native,
        agent: "selected",
        variant: "default",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: `${scenario} native busy turn` }],
      });
      await poll(() => provider.requests.length === before + 1);
      const inputs: { id: number; text: string }[] = [];
      for (let i = 0; i < count; i++) {
        inputs.push(
          await world!.reply(
            `${scenario} human ${i} ${crypto.randomUUID()}`,
            seed,
          ),
        );
      }
      await poll(() =>
        world!.first.service.app.routing!.store.read().deliveries
          .filter((d) => d.state === "ready" && d.target_session === sessionID)
          .some((r) =>
            JSON.stringify(r.message_ids) ===
              JSON.stringify(inputs.map((m) => m.id))
          )
      );
      assertEquals((await wakeRows()).length, previous);
      assertEquals(provider.requests.length - before, 1);
      latch.resolve();
      await oc.final(sessionID, native);
      await poll(
        async () => (await wakeRows()).length === previous + 1,
        30_000,
      );
      const wake = (await wakeRows()).at(-1)!;
      const final = await oc.final(sessionID, wake.info.id);
      assertStringIncludes(
        final.parts.map((p) => p.text ?? "").join(""),
        answer,
      );
      assertEquals(provider.requests.length - before, 2);
      const body = wake.parts[0].text!;
      const positions = inputs.map((m) => body.indexOf(m.text));
      assert(
        positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
      );
      assertEquals(
        (wake.parts[0].metadata!.deltaChatWake as { messageIds: number[] })
          .messageIds,
        inputs.map((m) => m.id),
      );
      await proof(scenario, {
        sessionID,
        humanIDs: inputs.map((m) => m.id),
        deferredWhileBusy: true,
        wakeMessages: 1,
        wakeParts: wake.parts.length,
        providerWakeRequests: 1,
        userMessageID: wake.info.id,
        nativeAnswerID: final.info.id,
        coreOrderPreserved: true,
      });
    };
    await step(
      "S11 busy native turn defers admission",
      () => busyBatch(1, "S11"),
    );
    await step(
      "S12 busy human messages coalesce in core order",
      () => busyBatch(3, "S12"),
    );
    await step("S13 SELF history never wakes", async () => {
      const before = provider.requests.length;
      const previous = (await wakeRows()).length;
      const sent = await world!.tool<{ message_id: number }>(
        world!.first.client,
        "send_message",
        { chat_id: world!.room, text: `S13 SELF ${crypto.randomUUID()}` },
      );
      await poll(
        () =>
          world!.first.service.app.routing!.store.read().rooms.some((r) =>
            r.recent_ids.includes(sent.message_id)
          ),
        15_000,
      );
      assertEquals(provider.requests.length, before);
      assertEquals((await wakeRows()).length, previous);
      await proof("S13", {
        sessionID,
        selfID: sent.message_id,
        providerRequests: 0,
        wakeMessages: 0,
      });
    });
    await remainingWake({
      oc,
      provider,
      delay,
      world,
      sessionID,
      seed,
      observerLog,
      async reloadRelays(enabled) {
        await oc.api("/instance/dispose", "POST");
        await poll(async () =>
          (await ownedSnapshot()).relays.every((r) =>
            r.connections === 0 && r.connecting === 0 && r.cleanupFailures === 0
          )
        );
        await oc.stop();
        await oc.configure({ plugin: [[observerURL, pluginOptions(enabled)]] });
        await oc.start();
        await oc.api("/session/status");
      },
      query,
      step,
      proof,
    });
    await step(
      "J4 native abort is terminal and later fresh input still wakes",
      async () => {
        const before = provider.requests.length;
        const held = Promise.withResolvers<void>();
        releases.push(held.resolve);
        provider.queue.push({
          text: "J4 aborted text must not resume",
          hold: held.promise,
        });
        const incoming = await world!.reply(
          `J4 native abort ${crypto.randomUUID()}`,
          seed,
        );
        await poll(() => provider.requests.length === before + 1, 30_000);
        await oc.api(`/session/${sessionID}/abort`, "POST");
        await poll(async () => {
          const statuses = await oc.api<Record<string, { type: string }>>(
            "/session/status",
          );
          return !statuses[sessionID] || statuses[sessionID].type === "idle";
        }, 15_000);
        held.resolve();
        let aborted: Record<string, unknown> | undefined;
        await poll(async () => {
          aborted = (await query(
            "SELECT * FROM delivery WHERE session_id=?",
            sessionID,
          )).find((d) =>
            (JSON.parse(String(d.message_ids)) as number[]).includes(
              incoming.id,
            )
          );
          return aborted?.state === "aborted";
        }, 15_000);
        assertEquals(aborted!.continuations, 0);
        assertEquals(provider.requests.length - before, 1);
        provider.queue.push({ text: "J4 fresh native answer after abort" });
        const fresh = await world!.reply(
          `J4 fresh after abort ${crypto.randomUUID()}`,
          seed,
        );
        let wake: Awaited<ReturnType<typeof oc.messages>>[number] | undefined;
        await poll(async () => {
          wake = (await wakeRows()).find((m) =>
            m.parts.some((p) =>
              (p.metadata?.deltaChatWake as
                | { messageIds: number[] }
                | undefined)?.messageIds.includes(fresh.id)
            )
          );
          return !!wake;
        }, 30_000);
        assert(wake);
        const final = await oc.final(sessionID, wake.info.id);
        assertStringIncludes(
          final.parts.map((p) => p.text ?? "").join(""),
          "J4 fresh native answer after abort",
        );
        assertEquals(provider.requests.length - before, 2);
        await proof("native-abort", {
          sessionID,
          abortedIncomingID: incoming.id,
          freshIncomingID: fresh.id,
          continuations: 0,
          abortedRequests: 1,
          freshRequests: 1,
          nativeAnswerID: final.info.id,
        });
      },
    );
    await step(
      "S45 native input supersedes unanswered wake without continuation or room post",
      async () => {
        // J5 now owns real transport: establish that earlier completed answers
        // have landed before measuring zero posts attributable to takeover U.
        await poll(
          async () =>
            (await query("SELECT state FROM delivery")).every((d) =>
              !["admitted", "mirroring"].includes(String(d.state))
            ),
          30_000,
        );
        const before = provider.requests.length;
        const previous = (await wakeRows()).length;
        const beforeHistory = await world!.first.service.app.chats.messages(
          world!.room,
          { limit: 1 },
        );
        const coreAnchor = beforeHistory.at(-1)?.id;
        assert(
          coreAnchor,
          "S45 needs an actual existing pre-scenario core anchor",
        );
        const release = mcp.holdNext();
        releases.push(release);
        provider.queue.push({
          tool: {
            name: "fixture_send_message",
            args: { mode: "hold", text: "S45 held fixture tool" },
          },
        }, { text: "S45 answer to the newer native operator input" });
        const incoming = await world!.reply(
          `S45 old room intent ${crypto.randomUUID()}`,
          seed,
        );
        await poll(() => mcp.holding, 30_000);
        assertEquals((await wakeRows()).length, previous + 1);
        const wake = (await wakeRows()).at(-1)!;
        const operator = nativeIDs();
        await oc.prompt(sessionID, {
          messageID: operator,
          agent: "selected",
          variant: "default",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "S45 newer native operator intent" }],
        });
        await poll(async () => !!await oc.found(sessionID, operator));
        release();
        await oc.final(sessionID, operator);
        await poll(async () =>
          (await query("SELECT state,superseding_message_id FROM delivery"))
            .some((d) =>
              d.state === "superseded_by_native_input" &&
              d.superseding_message_id === operator
            )
        );
        assertEquals(provider.requests.length - before, 2);
        assertEquals((await wakeRows()).length, previous + 1);
        assert(
          (await oc.messages(sessionID)).some((m) =>
            m.info.id === wake.info.id
          ),
        );
        // Compare the actual subsequent core range, not two sliding latest
        // pages whose old SELF rows can disappear when human input arrives.
        const newMessageIDs: number[] = [];
        const newPostIDs: number[] = [];
        const visited = new Set([coreAnchor]);
        let afterId = coreAnchor;
        while (true) {
          const page = await world!.first.service.app.chats.messages(
            world!.room,
            {
              afterId,
              limit: 100,
            },
          );
          if (!page.length) break;
          newMessageIDs.push(...page.map((m) => m.id));
          newPostIDs.push(...page.filter((m) => m.fromSelf).map((m) => m.id));
          const next = page.at(-1)!.id;
          assert(!visited.has(next), "S45 anchored core history must progress");
          visited.add(next);
          afterId = next;
        }
        assert(
          newMessageIDs.includes(incoming.id),
          "S45 range must include its actual incoming message",
        );
        assertEquals(newPostIDs, []);
        const superseded = (await query(
          "SELECT continuations,mirror_message_ids,superseding_message_id FROM delivery WHERE user_message_id=? AND superseding_message_id=?",
          wake.info.id,
          operator,
        ))[0];
        assert(superseded);
        assertEquals(superseded.continuations, 0);
        assertEquals(JSON.parse(String(superseded.mirror_message_ids)), []);
        assertEquals(superseded.superseding_message_id, operator);
        await poll(() =>
          world!.first.service.app.routing!.store.read().deliveries.some((d) =>
            d.outcome === "superseded_by_native_input" &&
            d.message_ids.includes(incoming.id)
          )
        );
        const inspect = nativeIDs();
        provider.queue.push({
          tool: { name: "relay_room_subscriptions", args: {} },
        }, { text: "S45 inspected durable delivery outcome" });
        await oc.prompt(sessionID, {
          messageID: inspect,
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "Inspect the delivery state" }],
        });
        await oc.final(sessionID, inspect);
        const part = (await oc.messages(sessionID)).flatMap((m) => m.parts)
          .findLast((p) => p.tool === "relay_room_subscriptions");
        assertStringIncludes(
          part!.state!.output!,
          "superseded_by_native_input",
        );
        assertEquals(JSON.parse(part!.state!.output!).isError, undefined);
        await proof("S45", {
          sessionID,
          incomingID: incoming.id,
          userMessageID: wake.info.id,
          supersedingNativeID: operator,
          preScenarioCoreAnchor: coreAnchor,
          observedSubsequentCoreIDs: newMessageIDs,
          providerRequestsBeforeInspection: 2,
          continuations: 0,
          roomPosts: newPostIDs.length,
          newSelfPostIDs: newPostIDs,
          retainedWake: true,
          durableStateAtListConsumer: true,
        });
      },
    );
    await step(
      "S46 fresh room message still wakes same session and posts exactly once",
      async () => {
        const before = provider.requests.length;
        const previous = (await wakeRows()).length;
        provider.queue.push({ text: "S46 fresh native answer after takeover" });
        const incoming = await world!.reply(
          `S46 fresh human ${crypto.randomUUID()}`,
          seed,
        );
        await poll(
          async () => (await wakeRows()).length === previous + 1,
          30_000,
        );
        const wake = (await wakeRows()).at(-1)!;
        const final = await oc.final(sessionID, wake.info.id);
        assertEquals(provider.requests.length - before, 1);
        assertStringIncludes(
          final.parts.map((p) => p.text ?? "").join(""),
          "S46 fresh native answer after takeover",
        );
        const peer = await world!.receivesComplete(
          "S46 fresh native answer after takeover",
        );
        const posts =
          (await world!.first.service.app.chats.messages(world!.room, {
            limit: 100,
          })).filter((m) =>
            m.fromSelf && m.text === "S46 fresh native answer after takeover"
          );
        assertEquals(posts.length, 1);
        await proof("S46-native", {
          sessionID,
          incomingID: incoming.id,
          userMessageID: wake.info.id,
          nativeAnswerID: final.info.id,
          providerRequests: 1,
          wakeMessages: 1,
          wakeParts: wake.parts.length,
          roomPostID: posts[0].id,
          peerMessageID: peer.id,
          roomPosts: 1,
          exactCompletePeerBody: true,
        });
      },
    );
    await step(
      "S20 instance disposal releases listeners and reloaded instance catches up once",
      async () => {
        await poll(async () =>
          (await ownedSnapshot()).relays.some((r) => r.connections > 0)
        );
        assertEquals(
          world!.first.service.app.events.listenerCount,
          listenerBaseline,
        );
        const before = provider.requests.length;
        const previous = (await wakeRows()).length;
        await oc.api("/instance/dispose", "POST");
        await poll(
          async () =>
            (await ownedSnapshot()).relays.every((r) =>
              r.connections === 0 && r.connecting === 0 &&
              r.cleanupFailures === 0
            ),
          10_000,
        );
        const incoming = await world!.reply(
          `S20 disposed catch-up ${crypto.randomUUID()}`,
          seed,
        );
        assertEquals(provider.requests.length, before);
        provider.queue.push({ text: "S20 reloaded native answer" });
        await oc.api("/session/status");
        await poll(
          async () => (await wakeRows()).length === previous + 1,
          30_000,
        );
        const wake = (await wakeRows()).at(-1)!;
        const final = await oc.final(sessionID, wake.info.id);
        assertEquals(provider.requests.length - before, 1);
        assertStringIncludes(
          final.parts.map((p) => p.text ?? "").join(""),
          "S20 reloaded native answer",
        );
        await proof("S20", {
          sessionID,
          incomingID: incoming.id,
          baselineListeners: listenerBaseline,
          disposedListeners: listenerBaseline,
          userMessageID: wake.info.id,
          nativeAnswerID: final.info.id,
          providerRequests: 1,
          catchupWakes: 1,
        });
      },
    );
    await step(
      "S39 plugin-owned enabled:false pauses all owned work; reload resumes the retained server batch once",
      async () => {
        const before = provider.requests.length;
        const previous = (await wakeRows()).length;
        const oldEpoch = (await ownedSnapshot()).epoch;
        await oc.api("/instance/dispose", "POST");
        await poll(
          async () =>
            (await ownedSnapshot()).relays.every((r) =>
              r.connections === 0 && r.connecting === 0 &&
              r.cleanupFailures === 0
            ) &&
            world!.first.service.app.events.listenerCount === listenerBaseline,
          10_000,
        );
        await oc.stop();
        await oc.configure({ plugin: [[observerURL, pluginOptions(false)]] });
        await oc.start();
        await oc.api("/session/status");
        await poll(async () => (await ownedSnapshot()).epoch !== oldEpoch);
        const disabled = await ownedSnapshot();
        assert(
          disabled.relays.every((r) =>
            !r.enabled && r.connections === 0 && r.connecting === 0
          ),
        );
        const router = world!.first.service.app.routing!;
        const interval = router.store.read().rooms.find((r) =>
          r.chat_id === world!.room
        )!.interval;
        const incoming = await world!.reply(
          `S39 disabled incoming ${crypto.randomUUID()}`,
          seed,
        );
        assertEquals(provider.requests.length, before);
        assertEquals((await wakeRows()).length, previous);
        // The server keeps scanning/retaining the batch while its local receiver
        // is paused. Only native admission and plugin I/O are paused.
        await poll(() =>
          router.store.read().deliveries.some((d) =>
            d.state === "ready" && d.message_ids.includes(incoming.id)
          )
        );
        assertEquals(
          router.store.read().rooms.find((r) => r.chat_id === world!.room)!
            .interval,
          interval,
        );
        provider.queue.push({ text: "S39 enabled catch-up native answer" });
        await oc.api("/instance/dispose", "POST");
        await oc.stop();
        await oc.configure({ plugin: [[observerURL, pluginOptions(true)]] });
        await oc.start();
        await oc.api("/session/status");
        await poll(
          async () => (await wakeRows()).length === previous + 1,
          30_000,
        );
        const wake = (await wakeRows()).at(-1)!;
        const final = await oc.final(sessionID, wake.info.id);
        assertEquals(provider.requests.length - before, 1);
        assertStringIncludes(
          final.parts.map((p) => p.text ?? "").join(""),
          "S39 enabled catch-up native answer",
        );
        const activeEpoch = (await ownedSnapshot()).epoch;
        await oc.api("/instance/dispose", "POST");
        // Establish the same actual shutdown barrier as S20 before killing the
        // process; a new process's disabled configuration cannot acknowledge an
        // older generation's still-draining relay request.
        await poll(
          async () =>
            (await ownedSnapshot()).relays.every((r) =>
              r.connections === 0 && r.connecting === 0 &&
              r.cleanupFailures === 0
            ),
          10_000,
        );
        await proof("S39-dispose-barrier", {
          sessionID,
          oldEpoch: activeEpoch,
          listeners: world!.first.service.app.events.listenerCount,
        });
        await oc.stop();
        await oc.configure({
          plugin: [[observerURL, pluginOptions(false)]],
        });
        await oc.start();
        await oc.api("/session/status");
        await poll(
          async () => (await ownedSnapshot()).epoch !== activeEpoch,
          10_000,
        );
        const disabledSnapshot = await ownedSnapshot();
        assert(
          disabledSnapshot.relays.every((r) =>
            !r.enabled && r.connections === 0 && r.connecting === 0 &&
            r.cleanupFailures === 0
          ),
        );
        assertEquals(
          world!.first.service.app.events.listenerCount,
          listenerBaseline,
        );
        assertEquals(provider.requests.length - before, 1);
        await proof("S39", {
          sessionID,
          incomingID: incoming.id,
          retainedSubscriptionInterval: interval,
          pluginRelayConnections: 0,
          pluginRelayConnecting: 0,
          pluginCleanupFailures: 0,
          pausedListenersAboveBaseline: 0,
          providerRequests: 1,
          catchupWakes: 1,
          configEnabledFalse: true,
          oldEpoch,
          disabledEpoch: disabledSnapshot.epoch,
          userMessageID: wake.info.id,
          nativeAnswerID: final.info.id,
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
    await world?.close();
  }
}
