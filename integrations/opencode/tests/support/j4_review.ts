// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { poll } from "../../../../tests/support.ts";
import { openSqlite } from "../../sqlite.ts";
import { ProviderFixture } from "./provider_fixture.ts";
import { McpFixture } from "./mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./opencode_process.ts";
import { relayWorld } from "./relay_world.ts";

interface Snapshot {
  epoch: string;
  metrics: {
    nativeCalls: Record<string, number>;
    registryWrites: number;
    events: Record<string, number>;
    notifications: { message: string }[];
    acceptedToasts: number;
  };
}

/** Real native/Core/wire regression world for the three J4 review classes. */
export async function reviewWake(t: Deno.TestContext) {
  const provider = new ProviderFixture(),
    mcp = new McpFixture(),
    delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  const state = `${oc.root}/review/wake.sqlite`;
  const observerLog = `${oc.root}/review-observer.json`;
  const observerURL =
    new URL("../fixtures/wake-observer-plugin.ts", import.meta.url).href;
  let edges: Record<
    string,
    { url: string; headers: Record<string, string>; enabled: boolean }
  >;
  const options = (enabledA: boolean) => ({
    relays: { ...edges, a: { ...edges.a, enabled: enabledA } },
    stateFile: state,
    observerLog,
  });
  const reloadAliasA = async (enabled: boolean) => {
    await oc.api("/instance/dispose", "POST");
    await oc.stop();
    await oc.configure({ plugin: [[observerURL, options(enabled)]] });
    await oc.start();
    await oc.api("/session/status");
  };
  const releases: (() => void)[] = [];
  let world: Awaited<ReturnType<typeof relayWorld>> | undefined;
  let sessionID = "";
  const model = { providerID: "test", modelID: "test-model" };
  const nativeID = () =>
    `msg_j4review${crypto.randomUUID().replaceAll("-", "")}`;
  const snapshot = async () =>
    JSON.parse(await Deno.readTextFile(observerLog)) as Snapshot;
  const query = async (sql: string, ...args: (string | number)[]) => {
    const db = await openSqlite(state, true);
    try {
      return db.all(sql, ...args);
    } finally {
      db.close();
    }
  };
  const users = async () =>
    (await oc.messages(sessionID)).filter((m) => m.info.role === "user");
  const proof = async (scenario: string, facts: Record<string, unknown>) => {
    const row = {
      time: new Date().toISOString(),
      scenario,
      version: await oc.version(),
      sessionID,
      ...facts,
      state: oc.root,
    };
    await Deno.writeTextFile(
      `${oc.root}/j4-review-facts.jsonl`,
      JSON.stringify(row) + "\n",
      { append: true, mode: 0o600 },
    );
    console.log(JSON.stringify(row));
  };
  const step = async (name: string, run: () => Promise<void>) => {
    if (!await t.step(name, run)) {
      throw new Error(`J4 review ${name} failed; preserved ${oc.root}`);
    }
  };
  const prompt = async (text: string) => {
    const messageID = nativeID();
    await oc.prompt(sessionID, {
      messageID,
      agent: "selected",
      model,
      variant: "default",
      parts: [{ type: "text", text }],
    });
    return messageID;
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    provider.queue.push({ tool: { name, args } }, {
      text: "Review explicit native tool completed",
    });
    const id = await prompt(`Review explicit ${name}`);
    await oc.final(sessionID, id);
    const part = (await oc.messages(sessionID)).flatMap((m) => m.parts)
      .findLast((p) => p.tool === name);
    assertEquals(part?.state?.status, "completed");
    const envelope = JSON.parse(part!.state!.output!);
    assert(!envelope.isError);
    assertEquals(
      envelope.content[0].text,
      JSON.stringify(envelope.structuredContent),
    );
    return envelope.structuredContent;
  };
  const receive = async (human: number, text: string, timeout = 30_000) => {
    let wake: Awaited<ReturnType<typeof oc.messages>>[number] | undefined;
    const matches = async () =>
      (await oc.messages(sessionID)).filter((m) =>
        m.parts.some((p) =>
          (p.metadata?.deltaChatWake as { messageIds: number[] } | undefined)
            ?.messageIds.includes(human)
        )
      );
    await poll(async () => {
      wake = (await matches())[0];
      return !!wake;
    }, timeout);
    assert(wake);
    const final = await oc.final(sessionID, wake.info.id);
    assertStringIncludes(final.parts.map((p) => p.text ?? "").join(""), text);
    assertEquals((await matches()).length, 1);
    assertEquals(wake.parts.length, 1);
    return { wake, final };
  };
  const sub = (room: number) => {
    const row = world!.first.service.app.routing!.store.read().rooms.find((r) =>
      r.chat_id === room
    );
    assert(row);
    return Promise.resolve(row);
  };
  const delivery = async (
    human: number,
  ): Promise<Record<string, unknown> | undefined> => {
    const local =
      (await query("SELECT * FROM delivery WHERE session_id=?", sessionID))
        .find((d) =>
          (JSON.parse(String(d.message_ids)) as number[]).includes(human)
        );
    if (local) return local;
    const remote = world!.first.service.app.routing!.store.read().deliveries
      .find((d) => d.message_ids.includes(human));
    return remote ? { ...remote, id: remote.delivery_id } : undefined;
  };
  const queued = async (human: number) => {
    await poll(async () => (await delivery(human))?.state === "ready", 15_000);
  };
  const seedRoom = async (alias: string, name: string, existing?: number) => {
    const room = existing ??
      (await world!.tool<{ chat_id: number }>(
        world!.first.client,
        "create_room",
        { name, contact_ids: [world!.contact] },
      )).chat_id;
    const seed = `${name}-${crypto.randomUUID()}`;
    await tool(`${alias}_send_message`, { chat_id: room, text: seed });
    await world!.receives(seed);
    return { room, seed, alias };
  };
  const deleteRing = async (room: number) => {
    const row = await sub(room);
    const ring = row.recent_ids;
    const status = await world!.tool<
      { messages: { messageId: number; state: string }[] }
    >(world!.first.client, "message_status", { message_ids: ring });
    const present = status.messages.filter((m) => m.state !== "not_found").map((
      m,
    ) => m.messageId);
    if (present.length) {
      await world!.tool(world!.first.client, "delete_messages", {
        message_ids: present,
      });
    }
    await poll(
      async () => (await sub(room)).state === "blocked_discontinuity",
      15_000,
    );
    return row.anchor_id;
  };
  const notified = async (room: number) => {
    await poll(
      async () =>
        (await snapshot()).metrics.notifications.some((n) =>
          n.message.includes(`room ${room} blocked_discontinuity`)
        ),
      10_000,
    );
  };
  try {
    world = await relayWorld({ gateWaitResponses: true });
    world.releaseWaitResponses();
    const direct = {
      ...world.first.config,
      url: `http://127.0.0.1:${world.first.service.addr.port}/mcp`,
    };
    // Independent receiver edges use distinct keys/namespaces. Same-key aliases
    // are interchangeable transports, not server routing partitions.
    const secondKey = await world.first.service.app.apiKeys.create(
      "J4 independent B edge",
    );
    edges = {
      a: {
        url: world.first.config.url,
        headers: world.first.config.headers,
        enabled: true,
      },
      b: {
        url: direct.url,
        headers: { Authorization: `Bearer ${secondKey.key}` },
        enabled: true,
      },
    };
    await oc.configure({
      plugin: [[
        observerURL,
        options(true),
      ]],
      mcp: {},
    });
    await oc.start();
    sessionID = (await oc.session("J4 review native ownership")).id;
    const a = await seedRoom("a", "review A", world.room);
    const b = await seedRoom("b", "review B");

    await step(
      "review stream1000deltas cause no native reconcile lookups without pending work",
      async () => {
        const before = await snapshot();
        const requests = provider.requests.length;
        provider.queue.push({ text: "review-stream", chunks: 1000 });
        const native = await prompt("Review native operator streaming turn");
        const final = await oc.final(sessionID, native);
        assertStringIncludes(
          final.parts.map((p) => p.text ?? "").join(""),
          "review-stream-999",
        );
        await poll(
          async () =>
            ((await snapshot()).metrics.events["message.part.delta"] ?? 0) -
                (before.metrics.events["message.part.delta"] ?? 0) >= 1000,
          10_000,
        );
        const after = await snapshot();
        assertEquals(
          (after.metrics.nativeCalls["session.get"] ?? 0) -
            (before.metrics.nativeCalls["session.get"] ?? 0),
          0,
        );
        assertEquals(provider.requests.length - requests, 1);
        await proof("review-stream", {
          deltas: after.metrics.events["message.part.delta"] -
            (before.metrics.events["message.part.delta"] ?? 0),
          nativeReconcileSessionLookups: 0,
          registryWritesObservedIncludingWatchLeases:
            after.metrics.registryWrites - before.metrics.registryWrites,
          providerRequests: 1,
          nativeAnswerID: final.info.id,
        });
      },
    );

    await step(
      "review queued alias A pause or read failure cannot starve independent B",
      async () => {
        for (const mode of ["disabled", "read-failure"] as const) {
          if (mode === "disabled") await reloadAliasA(false);
          else world!.failReadResponses(true);
          const requests = provider.requests.length;
          const held = Promise.withResolvers<void>();
          releases.push(held.resolve);
          provider.queue.push({
            text: `review ${mode} operator final`,
            hold: held.promise,
          }, { text: `review ${mode} B answer` });
          const native = await prompt(`Review busy ${mode}`);
          await poll(() => provider.requests.length === requests + 1);
          const incomingA = await world!.reply(
            `review ${mode} A ${crypto.randomUUID()}`,
            a.seed,
            a.room,
          );
          await queued(incomingA.id);
          if (mode === "disabled") {
            assertEquals(
              (await sub(a.room)).members.some((m) =>
                m.session_id === sessionID && m.joined
              ),
              true,
            );
          }
          const incomingB = await world!.reply(
            `review ${mode} B ${crypto.randomUUID()}`,
            b.seed,
            b.room,
          );
          await queued(incomingB.id);
          held.resolve();
          await oc.final(sessionID, native);
          const answerB = await receive(
            incomingB.id,
            `review ${mode} B answer`,
          );
          if (mode === "read-failure") {
            await poll(() => world!.rejectedReads() > 0);
          }
          assertEquals(
            (await delivery(incomingA.id))?.state,
            mode === "disabled" ? "ready" : "open",
          );
          assertEquals(
            (await query(
              "SELECT * FROM submission WHERE delivery_id=?",
              String((await delivery(incomingA.id))!.id),
            )).length,
            0,
          );
          assertEquals(provider.requests.length - requests, 2);
          if (mode === "read-failure") {
            assert(world!.rejectedReads() > 0);
            // Stop the failing edge before releasing its gate so no unqueued
            // native turn can race the test's resumption script.
            await reloadAliasA(false);
            world!.failReadResponses(false);
          }
          provider.queue.push({ text: `review ${mode} A answer` });
          await reloadAliasA(true);
          const answerA = await receive(
            incomingA.id,
            `review ${mode} A answer`,
          );
          assertEquals(provider.requests.length - requests, 3);
          await proof(
            mode === "disabled"
              ? "review-room-isolation"
              : "review-edge-failure",
            {
              humanA: incomingA.id,
              humanB: incomingB.id,
              nativeB: answerB.wake.info.id,
              nativeA: answerA.wake.info.id,
              bWakesWhileADeferred: 1,
              aCatchupWakes: 1,
              providerRequests: 3,
              rejectedReads: world!.rejectedReads(),
            },
          );
        }
      },
    );

    await step(
      "review same-alias gap and busy health toast create no native input and B wakes",
      async () => {
        const c = await seedRoom("b", "review blocked C");
        const userIDs = (await users()).map((m) => m.info.id);
        const requests = provider.requests.length;
        const held = Promise.withResolvers<void>();
        releases.push(held.resolve);
        provider.queue.push({
          text: "review busy operator final",
          hold: held.promise,
        }, { text: "review B after C gap" });
        const native = await prompt("Review busy native operator intent");
        await poll(() => provider.requests.length === requests + 1);
        const incomingC = await world!.reply(
          `review blocked C ${crypto.randomUUID()}`,
          c.seed,
          c.room,
        );
        await queued(incomingC.id);
        const anchor = await deleteRing(c.room);
        await notified(c.room);
        assertEquals((await users()).map((m) => m.info.id), [
          ...userIDs,
          native,
        ]);
        assertEquals(provider.requests.length - requests, 1);
        assertEquals((await sub(c.room)).anchor_id, anchor);
        const incomingB = await world!.reply(
          `review B independent gap ${crypto.randomUUID()}`,
          b.seed,
          b.room,
        );
        await queued(incomingB.id);
        held.resolve();
        await oc.final(sessionID, native);
        const answer = await receive(incomingB.id, "review B after C gap");
        assertEquals(provider.requests.length - requests, 2);
        assertEquals((await delivery(incomingC.id))?.state, "ready");
        await tool("b_room_leave", { chat_id: c.room });
        await proof("review-gap-busy-toast", {
          blockedRoom: c.room,
          blockedAnchor: anchor,
          nativeOperatorID: native,
          bNativeID: answer.wake.info.id,
          healthUserRows: 0,
          healthProviderRequests: 0,
          bWakes: 1,
          nativeToastObserved: true,
        });
      },
    );

    await step(
      "review idle health notification racing new operator never becomes user input",
      async () => {
        const d = await seedRoom("b", "review idle D");
        const userIDs = (await users()).map((m) => m.info.id);
        const requests = provider.requests.length;
        delay.armNextToast();
        await deleteRing(d.room);
        let gate = "";
        await poll(() => {
          gate = [...delay.held.keys()].find((key) =>
            key.startsWith("toast_")
          ) ?? "";
          return !!gate;
        }, 10_000);
        const held = Promise.withResolvers<void>();
        releases.push(held.resolve);
        provider.queue.push({
          text: "review raced operator answer",
          hold: held.promise,
        });
        const native = await prompt(
          "Review newer native operator during notification",
        );
        await poll(() => provider.requests.length === requests + 1);
        delay.release(gate);
        await notified(d.room);
        assertEquals((await users()).map((m) => m.info.id), [
          ...userIDs,
          native,
        ]);
        held.resolve();
        await oc.final(sessionID, native);
        assertEquals(provider.requests.length - requests, 1);
        await tool("b_room_leave", { chat_id: d.room });
        await proof("review-idle-race-toast", {
          blockedRoom: d.room,
          nativeOperatorID: native,
          healthUserRows: 0,
          healthProviderRequests: 0,
          nativeToastObserved: true,
        });
      },
    );

    await step(
      "review left same-epoch uncertain original blocks B; dead epoch respects newer native intent and B wakes",
      async () => {
        delay.armNextWake("hold");
        const incomingA = await world!.reply(
          `review kill A ${crypto.randomUUID()}`,
          a.seed,
          a.room,
        );
        let original = "";
        await poll(() => {
          original = [...delay.held.keys()].find((key) =>
            key.startsWith("msg_")
          ) ?? "";
          return !!original;
        }, 30_000);
        await poll(async () =>
          (await delivery(incomingA.id))?.state === "submitted"
        );
        const originalDelivery = (await delivery(incomingA.id))!;
        const oldSubmission = (await query(
          "SELECT * FROM submission WHERE delivery_id=?",
          String(originalDelivery.id),
        ))[0];
        await tool("a_room_leave", { chat_id: a.room });
        const superseding = (await users()).at(-1)!.info.id;
        const requests = provider.requests.length;
        const incomingB = await world!.reply(
          `review kill B ${crypto.randomUUID()}`,
          b.seed,
          b.room,
        );
        await queued(incomingB.id);
        assertEquals(provider.requests.length, requests);
        assertEquals(
          (await query(
            "SELECT * FROM submission WHERE delivery_id=?",
            String((await delivery(incomingB.id))!.id),
          )).length,
          0,
        );
        assertEquals((await delivery(incomingA.id))?.state, "submitted");
        assertEquals(await oc.found(sessionID, original), undefined);
        await oc.stop("SIGKILL");
        delay.release(original);
        provider.queue.push({ text: "review B after killed left A" });
        await oc.start();
        await oc.api("/session/status");
        const answerB = await receive(
          incomingB.id,
          "review B after killed left A",
          120_000,
        );
        const currentA = (await delivery(incomingA.id))!;
        assertEquals(currentA.state, "superseded_by_native_input");
        assertEquals(currentA.reason, "native_input");
        assertEquals(currentA.superseding_message_id, superseding);
        assertEquals(
          (await query(
            "SELECT * FROM submission WHERE delivery_id=?",
            String(originalDelivery.id),
          ))[0].attempts,
          1,
        );
        assertEquals(await oc.found(sessionID, original), undefined);
        assertEquals(provider.requests.length - requests, 1);
        await poll(async () =>
          (await snapshot()).epoch !== oldSubmission.submit_epoch
        );
        await proof("review-left-epoch", {
          originalID: original,
          originalPartID: oldSubmission.part_id,
          stateA: "superseded_by_native_input",
          supersedingNativeID: superseding,
          attemptsA: 1,
          sameEpochBSubmissions: 0,
          nativeB: answerB.wake.info.id,
          providerRequestsAfterRestart: 1,
          changedEpoch: true,
          originalExited: true,
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
