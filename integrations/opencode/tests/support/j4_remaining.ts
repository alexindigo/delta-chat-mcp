// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { poll } from "../../../../tests/support.ts";
import type { ProviderFixture } from "./provider_fixture.ts";
import type { DelayControl, OpenCodeProcess } from "./opencode_process.ts";
import type { relayWorld } from "./relay_world.ts";

export interface RemainingWorld {
  oc: OpenCodeProcess;
  provider: ProviderFixture;
  delay: DelayControl;
  world: Awaited<ReturnType<typeof relayWorld>>;
  sessionID: string;
  seed: string;
  observerLog: string;
  reloadRelays(enabled: Record<string, boolean>): Promise<void>;
  query(
    sql: string,
    ...args: (string | number | null)[]
  ): Promise<Record<string, unknown>[]>;
  step(name: string, run: () => Promise<void>): Promise<void>;
  proof(name: string, facts: Record<string, unknown>): Promise<void>;
}

export async function remainingWake(c: RemainingWorld) {
  const {
    oc,
    provider,
    delay,
    world,
    sessionID,
    seed,
    query,
    step,
    proof,
    observerLog,
    reloadRelays,
  } = c;
  const model = { providerID: "test", modelID: "test-model" };
  const id = () => `msg_j4${crypto.randomUUID().replaceAll("-", "")}`;
  const wakes = async (session = sessionID) =>
    (await oc.messages(session)).filter((m) =>
      m.parts.some((p) => p.metadata?.deltaChatWake)
    );
  const deliveryFor = async (human: number) =>
    (await query("SELECT * FROM delivery")).find((d) =>
      (JSON.parse(String(d.message_ids)) as number[]).includes(human)
    );
  const roomState = (chat = world.room) => {
    const row = world.first.service.app.routing!.store.read().rooms.find((r) =>
      r.chat_id === chat
    );
    assert(row, "The owning server must retain this room's routing metadata");
    return row;
  };
  const receive = async (
    human: number,
    session = sessionID,
    timeout = 30_000,
  ) => {
    let found: Awaited<ReturnType<typeof wakes>>[number] | undefined;
    await poll(async () => {
      found = (await wakes(session)).find((m) =>
        m.parts.some((p) =>
          (p.metadata?.deltaChatWake as { messageIds: number[] } | undefined)
            ?.messageIds.includes(human)
        )
      );
      return !!found;
    }, timeout);
    assert(found);
    const final = await oc.final(session, found.info.id);
    const matches = (await wakes(session)).filter((m) =>
      m.parts.some((p) =>
        (p.metadata?.deltaChatWake as { messageIds: number[] } | undefined)
          ?.messageIds.includes(human)
      )
    );
    assertEquals(matches.length, 1);
    assertEquals(found.parts.length, 1);
    return { wake: found, final };
  };
  const tool = async (
    name: string,
    args: Record<string, unknown>,
    session = sessionID,
  ) => {
    const native = id();
    provider.queue.push({ tool: { name, args } }, {
      text: "J4 explicit native tool turn completed",
    });
    await oc.prompt(session, {
      messageID: native,
      agent: "selected",
      model,
      variant: "default",
      parts: [{ type: "text", text: `J4 explicit ${name}` }],
    });
    await oc.final(session, native);
    const part = (await oc.messages(session)).flatMap((m) => m.parts).findLast((
      p,
    ) => p.tool === name);
    assertEquals(part?.state?.status, "completed");
    const envelope = JSON.parse(part!.state!.output!);
    assert(!envelope.isError);
    assertEquals(
      envelope.content[0].text,
      JSON.stringify(envelope.structuredContent),
    );
    return envelope.structuredContent;
  };
  const disposeClean = async () => {
    await oc.api("/instance/dispose", "POST");
    await poll(
      async () =>
        (JSON.parse(await Deno.readTextFile(observerLog)) as {
          relays: {
            connections: number;
            connecting: number;
            cleanupFailures: number;
          }[];
        }).relays.every((r) =>
          r.connections === 0 && r.connecting === 0 && r.cleanupFailures === 0
        ) &&
        (await query("SELECT * FROM lease WHERE session_id=?", sessionID))
            .length === 0,
      10_000,
    );
    await oc.stop();
  };
  const resubscribe = async () => {
    const sent = await tool("relay_send_message", {
      chat_id: world.room,
      text: `J4 re-subscribe ${crypto.randomUUID()}`,
    });
    const row = sent.routing;
    assertEquals(
      row?.state,
      "active",
      `Accepted send ${sent.message_id} must re-subscribe this session`,
    );
    assertEquals(row.session_id, sessionID);
    assertEquals(row.subscribed, true);
    return sent;
  };
  const waitQueued = async (human: number) => {
    await poll(
      () =>
        world.first.service.app.routing!.store.read().deliveries.some((d) =>
          d.state === "ready" && d.message_ids.includes(human)
        ),
      15_000,
    );
  };

  await step(
    "S10 full canonical quote/forward/HTML completeness reaches native consumer",
    async () => {
      for (const kind of ["quote", "forward", "html"] as const) {
        const before = provider.requests.length;
        provider.queue.push({ text: `S10 ${kind} native answer` });
        const marker = `S10-${kind}-${crypto.randomUUID()}`;
        const incoming = kind === "quote"
          ? await world.quotedReply(marker, seed)
          : kind === "forward"
          ? await world.forwardedReply(seed)
          : await world.htmlReply(marker, seed);
        const result = await receive(incoming.id);
        const text = result.wake.parts[0].text!;
        const request = JSON.stringify(provider.requests[before]);
        assertStringIncludes(text, incoming.fromAddress);
        assertStringIncludes(request, incoming.fromAddress);
        assertStringIncludes(text, `textComplete=${incoming.textComplete}`);
        if (kind === "quote") {
          assertEquals(incoming.fromName, "J4 canonical peer override");
          assert(incoming.quote);
          assertStringIncludes(text, incoming.quote.text);
          assertStringIncludes(text, "BEGIN QUOTE TEXT");
          assertStringIncludes(text, incoming.quote.authorName!);
        } else if (kind === "forward") {
          assert(incoming.isForwarded);
          assertStringIncludes(text, "Forwarded message:");
        } else {
          assertEquals(incoming.textComplete, false);
          assert(incoming.html);
          assertStringIncludes(text, incoming.html);
          assertStringIncludes(request, marker);
        }
        assertEquals(provider.requests.length - before, 1);
        await proof(`S10-${kind}`, {
          sessionID,
          incomingID: incoming.id,
          userMessageID: result.wake.info.id,
          nativeAnswerID: result.final.info.id,
          providerRequests: 1,
          textComplete: incoming.textComplete,
          canonicalSender: incoming.fromAddress,
          isForwarded: incoming.isForwarded,
          hasQuote: !!incoming.quote,
        });
      }
    },
  );

  await step(
    "S10 custom native selection is preserved at actual provider",
    async () => {
      const native = id();
      await oc.prompt(sessionID, {
        messageID: native,
        noReply: true,
        agent: "selected",
        model,
        variant: "careful",
        parts: [{ type: "text", text: "Select careful explicitly" }],
      });
      await poll(async () => !!await oc.found(sessionID, native));
      const before = provider.requests.length;
      provider.queue.push({ text: "Custom variant native answer" });
      const incoming = await world.reply(
        `S10 custom variant ${crypto.randomUUID()}`,
        seed,
      );
      const result = await receive(incoming.id);
      const info = await oc.api(`/session/${sessionID}`);
      assertEquals(info.agent, "selected");
      assertEquals(info.model, {
        id: "test-model",
        providerID: "test",
        variant: "careful",
      });
      assertEquals(provider.requests[before].reasoning_effort, "high");
      assertEquals(provider.requests.length - before, 1);
      await proof("S10-custom-selection", {
        sessionID,
        nativeAnswerID: result.final.info.id,
        variant: "careful",
        actualProviderReasoningEffort: "high",
        providerRequests: 1,
      });
    },
  );

  await step(
    "S10 actual partial download facts survive body retrieval and native wake",
    async () => {
      const before = provider.requests.length;
      const marker = `S10 partial download ${crypto.randomUUID()}`;
      provider.queue.push({ text: "S10 partial-download native answer" });
      const incoming = await world.partialReply(marker, seed);
      assertEquals(incoming.attachmentDownloadState, "Available");
      assertEquals(incoming.textComplete, false);
      assertEquals(incoming.html, undefined);
      assert(incoming.hasAttachment && incoming.encrypted);
      const answer = await receive(incoming.id);
      const prompt = answer.wake.parts[0].text!;
      assertStringIncludes(prompt, 'downloadState="Available"');
      assertStringIncludes(prompt, "textComplete=false; completeHTML=false");
      assertStringIncludes(prompt, "not a complete-body claim");
      assertStringIncludes(prompt, incoming.attachmentName!);
      assertStringIncludes(prompt, marker);
      assertStringIncludes(JSON.stringify(provider.requests[before]), marker);
      const current = (await world.first.service.app.chats.messages(world.room))
        .find((m) => m.id === incoming.id)!;
      assertEquals(current.attachmentDownloadState, "Available");
      assertEquals(provider.requests.length - before, 1);
      await proof("S10-partial-download", {
        sessionID,
        incomingID: incoming.id,
        downloadState: current.attachmentDownloadState,
        textComplete: current.textComplete,
        nativeAnswerID: answer.final.info.id,
        bodyFactsAtConsumer: true,
        automaticDownloads: 0,
        providerRequests: 1,
      });
    },
  );

  await step(
    "S14 only latest subscribed recipient wakes; second room retains its own subscribed writer",
    async () => {
      const other = await oc.session("J4 S14 second subscribed writer");
      const room2 = (await world.tool<{ chat_id: number }>(
        world.first.client,
        "create_room",
        { name: "J4 second room", contact_ids: [world.contact] },
      )).chat_id;
      const seed2 = `S14 room2 ${crypto.randomUUID()}`;
      await tool("relay_send_message", {
        chat_id: world.room,
        text: `S14 other ${crypto.randomUUID()}`,
      }, other.id);
      await tool("relay_send_message", { chat_id: room2, text: seed2 });
      await world.receives(seed2);
      let before = provider.requests.length;
      provider.queue.push({ text: "S14 room1 answer" });
      const first = await world.reply(`S14 both ${crypto.randomUUID()}`, seed);
      const answer = await receive(first.id, other.id);
      assert(
        !(await wakes()).some((m) =>
          m.parts.some((p) =>
            (p.metadata?.deltaChatWake as { messageIds: number[] } | undefined)
              ?.messageIds.includes(first.id)
          )
        ),
      );
      assertEquals(provider.requests.length - before, 1);
      const otherBefore = (await wakes(other.id)).length;
      before = provider.requests.length;
      provider.queue.push({ text: "S14 room2 only A" });
      const second = await world.reply(
        `S14 only A ${crypto.randomUUID()}`,
        seed2,
        room2,
      );
      await receive(second.id);
      assertEquals(provider.requests.length - before, 1);
      assertEquals((await wakes(other.id)).length, otherBefore);
      await tool("relay_room_leave", {
        chat_id: world.room,
      }, other.id);
      await proof("S14", {
        sessions: [sessionID, other.id],
        rooms: [world.room, room2],
        latestRecipientWakeID: answer.wake.info.id,
        olderSubscriberRoom1Wakes: 0,
        room1Requests: 1,
        room2Requests: 1,
        otherRoom2Wakes: 0,
      });
    },
  );

  await step(
    "J4 same-key alias failover respects plugin enable state without changing server membership",
    async () => {
      await tool("twin_send_message", {
        chat_id: world.room,
        text: `J4 switch alias ${crypto.randomUUID()}`,
      });
      const interval = roomState().interval;
      await reloadRelays({ relay: false, twin: true });
      let before = provider.requests.length;
      provider.queue.push({ text: "Changed alias native answer" });
      const first = await world.reply(
        `J4 twin incoming ${crypto.randomUUID()}`,
        seed,
      );
      const answer = await receive(first.id);
      assertStringIncludes(answer.wake.parts[0].text!, 'server "twin"');
      assertEquals(provider.requests.length - before, 1);
      await reloadRelays({ relay: false, twin: false });
      before = provider.requests.length;
      const second = await world.reply(
        `J4 disabled twin ${crypto.randomUUID()}`,
        seed,
      );
      await waitQueued(second.id);
      assertEquals(roomState().interval, interval);
      assertEquals(provider.requests.length, before);
      provider.queue.push({ text: "Re-enabled twin answer" });
      await reloadRelays({ relay: true, twin: false });
      const restored = await receive(second.id);
      assertStringIncludes(restored.wake.parts[0].text!, 'server "relay"');
      assertEquals(provider.requests.length - before, 1);
      await resubscribe();
      await reloadRelays({ relay: true, twin: true });
      await proof("changed-alias", {
        sessionID,
        firstUserID: answer.wake.info.id,
        oldEdgeDisabledStillWakes: true,
        allEdgesPausedRetainsServerBatch: true,
        subscriptionIntervalUnchanged: true,
        secondIncomingID: second.id,
        catchupRequests: 1,
      });
    },
  );

  await step(
    "S15 admitted leave completes;later input stops;resend subscribes afresh",
    async () => {
      const before = provider.requests.length;
      const held = Promise.withResolvers<void>();
      provider.queue.push({
        tool: {
          name: "relay_room_leave",
          args: { chat_id: world.room },
        },
      }, {
        text: "S15 admitted native answer after leave",
        hold: held.promise,
      });
      try {
        const incoming = await world.reply(
          `S15 admitted ${crypto.randomUUID()}`,
          seed,
        );
        await poll(
          () =>
            roomState().members.some((m) =>
              m.session_id === sessionID && !m.joined
            ),
          30_000,
        );
        await poll(() => provider.requests.length === before + 2);
        const stopped = await world.reply(
          `S15 left ignored ${crypto.randomUUID()}`,
          seed,
        );
        held.resolve();
        const answer = await receive(incoming.id);
        assertStringIncludes(
          answer.final.parts.map((p) => p.text ?? "").join(""),
          "S15 admitted native answer after leave",
        );
        assertEquals(provider.requests.length - before, 2);
        assertEquals(await deliveryFor(stopped.id), undefined);
        const sent = await resubscribe();
        provider.queue.push({ text: "S15 fresh subscription native answer" });
        const fresh = await world.reply(
          `S15 fresh ${crypto.randomUUID()}`,
          seed,
        );
        await receive(fresh.id);
        await proof("S15", {
          sessionID,
          admittedIncoming: incoming.id,
          ignoredWhileLeft: stopped.id,
          freshAnchor: sent.message_id,
          freshIncoming: fresh.id,
          admittedTurnCompleted: true,
          reSubscribed: true,
        });
      } finally {
        held.resolve();
      }
    },
  );

  await step(
    "S15 delayed original survives leave and reconciles without overwriting newer native intent",
    async () => {
      delay.armNextWake("hold");
      const incoming = await world.reply(
        `S15 delayed original ${crypto.randomUUID()}`,
        seed,
      );
      let messageID = "";
      await poll(() => {
        messageID = [...delay.held.keys()][0] ?? "";
        return !!messageID;
      }, 30_000);
      await poll(async () =>
        (await deliveryFor(incoming.id))?.state === "submitted"
      );
      assertEquals(await oc.found(sessionID, messageID), undefined);
      const operator = id();
      const before = provider.requests.length;
      provider.queue.push({
        tool: {
          name: "relay_room_leave",
          args: { chat_id: world.room },
        },
      }, { text: "S15 newer native intent finished" });
      await oc.prompt(sessionID, {
        messageID: operator,
        agent: "selected",
        variant: "careful",
        model,
        parts: [{
          type: "text",
          text: "Leave room and retain this newer native intent",
        }],
      });
      await oc.final(sessionID, operator);
      assertEquals((await deliveryFor(incoming.id))?.state, "submitted");
      delay.release(messageID);
      await poll(async () => !!await oc.found(sessionID, messageID), 15_000);
      await poll(
        async () =>
          (await deliveryFor(incoming.id))?.state ===
            "superseded_by_native_input",
        15_000,
      );
      assertEquals(
        (await deliveryFor(incoming.id))?.superseding_message_id,
        operator,
      );
      assertEquals((await oc.found(sessionID, messageID))!.parts.length, 1);
      assertEquals(provider.requests.length - before, 2);
      assertEquals((await oc.api(`/session/${sessionID}`)).model, {
        id: "test-model",
        providerID: "test",
        variant: "careful",
      });
      await resubscribe();
      await proof("S15-delayed-leave", {
        sessionID,
        incomingID: incoming.id,
        originalID: messageID,
        supersedingNativeID: operator,
        oldProviderRequests: 0,
        originalRetained: true,
        freshSubmissionsWhileLeft: 0,
        latestVariant: "careful",
      });
    },
  );

  await step(
    "S16 pending revert defers without committing operator revert",
    async () => {
      const native = id();
      await oc.prompt(sessionID, {
        messageID: native,
        noReply: true,
        agent: "selected",
        model,
        variant: "default",
        parts: [{ type: "text", text: "S16 native revert boundary" }],
      });
      await poll(async () => !!await oc.found(sessionID, native));
      await oc.api(`/session/${sessionID}/revert`, "POST", {
        messageID: native,
      });
      assert((await oc.api(`/session/${sessionID}`)).revert);
      const before = provider.requests.length;
      const incoming = await world.reply(
        `S16 deferred ${crypto.randomUUID()}`,
        seed,
      );
      await waitQueued(incoming.id);
      assert((await oc.api(`/session/${sessionID}`)).revert);
      assertEquals(provider.requests.length, before);
      provider.queue.push({
        text: "S16 native answer after explicit unrevert",
      });
      await oc.api(`/session/${sessionID}/unrevert`, "POST");
      const answer = await receive(incoming.id);
      assertEquals(provider.requests.length - before, 1);
      await proof("S16", {
        sessionID,
        incomingID: incoming.id,
        revertRetainedWhileQueued: true,
        nativeAnswerID: answer.final.info.id,
        providerRequests: 1,
      });
    },
  );

  await step(
    "S17 deleted native session leaves its server batch unclaimed and is never submitted",
    async () => {
      const deleted = await oc.session("J4 S17 deleted session");
      const room = (await world.tool<{ chat_id: number }>(
        world.first.client,
        "create_room",
        { name: "J4 deleted session room", contact_ids: [world.contact] },
      )).chat_id;
      const marker = `S17 seed ${crypto.randomUUID()}`;
      await tool(
        "relay_send_message",
        { chat_id: room, text: marker },
        deleted.id,
      );
      await world.receives(marker);
      await oc.api(`/session/${deleted.id}`, "DELETE");
      const before = provider.requests.length;
      const incoming = await world.reply(
        `S17 incoming ${crypto.randomUUID()}`,
        marker,
        room,
      );
      await waitQueued(incoming.id);
      const missing = await oc.raw(`/session/${deleted.id}`);
      assertEquals(missing.status, 404);
      await missing.body?.cancel();
      assertEquals(provider.requests.length, before);
      assertEquals(
        (await query(
          "SELECT * FROM submission s JOIN delivery d ON d.id=s.delivery_id WHERE d.session_id=?",
          deleted.id,
        )).length,
        0,
      );
      await proof("S17", {
        deletedSessionID: deleted.id,
        incomingID: incoming.id,
        state: "ready_unclaimed_for_missing_native_session",
        providerRequests: 0,
        submissions: 0,
      });
    },
  );

  await step(
    "S18 real deleted anchor recovers through retained ring without redelivery",
    async () => {
      const sub = roomState();
      const ring = sub.recent_ids;
      assert(ring.length > 1 && ring.length <= 32);
      await world.tool(world.first.client, "delete_messages", {
        message_ids: [sub.anchor_id],
      });
      const before = provider.requests.length;
      provider.queue.push({ text: "S18 retained-ring answer" });
      const incoming = await world.reply(
        `S18 ring recovery ${crypto.randomUUID()}`,
        seed,
      );
      const answer = await receive(incoming.id);
      assertEquals(provider.requests.length - before, 1);
      await proof("S18", {
        sessionID,
        deletedAnchor: sub.anchor_id,
        retainedRing: ring.length,
        incomingID: incoming.id,
        nativeAnswerID: answer.final.info.id,
        providerRequests: 1,
        redeliveries: 0,
      });
    },
  );

  await step(
    "S18 deleted pending human body becomes source_deleted without fabricated input",
    async () => {
      const held = Promise.withResolvers<void>();
      const native = id();
      const before = provider.requests.length;
      provider.queue.push({
        text: "S18 held operator turn",
        hold: held.promise,
      });
      try {
        await oc.prompt(sessionID, {
          messageID: native,
          agent: "selected",
          model,
          variant: "default",
          parts: [{ type: "text", text: "S18 hold before source deletion" }],
        });
        await poll(() => provider.requests.length === before + 1);
        const incoming = await world.reply(
          `S18 deleted human ${crypto.randomUUID()}`,
          seed,
        );
        await waitQueued(incoming.id);
        await world.tool(world.first.client, "delete_messages", {
          message_ids: [incoming.id],
        });
        held.resolve();
        await oc.final(sessionID, native);
        await poll(
          async () =>
            (await deliveryFor(incoming.id))?.state === "source_deleted",
          15_000,
        );
        assertEquals(provider.requests.length - before, 1);
        await proof("S18-source-deleted", {
          sessionID,
          incomingID: incoming.id,
          state: "source_deleted",
          wakeRequests: 0,
          fabricatedBodies: 0,
        });
      } finally {
        held.resolve();
      }
    },
  );

  await step(
    "S18b exhausted ring blocks with unchanged anchor until explicit native resume",
    async () => {
      const usersBefore = (await oc.messages(sessionID)).filter((m) =>
        m.info.role === "user"
      ).map((m) => m.info.id);
      const sub = roomState();
      const ring = sub.recent_ids;
      const existing = await world.tool<
        { messages: { messageId: number; state: string }[] }
      >(world.first.client, "message_status", { message_ids: ring });
      const present = existing.messages.filter((m) => m.state !== "not_found")
        .map((m) => m.messageId);
      if (present.length) {
        await world.tool(world.first.client, "delete_messages", {
          message_ids: present,
        });
      }
      const removed = await world.tool<{ messages: { state: string }[] }>(
        world.first.client,
        "message_status",
        { message_ids: ring },
      );
      assert(removed.messages.every((m) => m.state === "not_found"));
      await poll(
        () => roomState().state === "blocked_discontinuity",
        15_000,
      );
      const chosen = await world.tool<{ message_id: number }>(
        world.first.client,
        "send_message",
        {
          chat_id: world.room,
          text: `S18b explicit recovery point ${crypto.randomUUID()}`,
        },
      );
      const before = provider.requests.length;
      const incoming = await world.reply(
        `S18b retained blocked input ${crypto.randomUUID()}`,
        seed,
      );
      assertEquals(provider.requests.length, before);
      assertEquals(
        roomState().anchor_id,
        sub.anchor_id,
      );
      await poll(async () => {
        const state = JSON.parse(await Deno.readTextFile(observerLog)) as {
          metrics: {
            notifications: { message: string }[];
            acceptedToasts: number;
          };
        };
        return state.metrics.acceptedToasts > 0 &&
          state.metrics.notifications.some((n) =>
            n.message.includes(`room ${world.room} blocked_discontinuity`)
          );
      }, 10_000);
      assertEquals(
        (await oc.messages(sessionID)).filter((m) => m.info.role === "user")
          .map((m) => m.info.id),
        usersBefore,
      );
      const listed = await tool("relay_room_subscriptions", {});
      assert(
        listed.subscriptions.some((
          s: { chat_id: number; state: string; anchor_id: number },
        ) =>
          s.chat_id === world.room && s.state === "blocked_discontinuity" &&
          s.anchor_id === sub.anchor_id
        ),
      );
      const native = id();
      provider.queue.push(
        {
          tool: {
            name: "relay_room_resume",
            args: {
              chat_id: world.room,
              after_id: chosen.message_id,
            },
          },
        },
        { text: "S18b explicitly resumed" },
        { text: "S18b pending human native answer" },
      );
      await oc.prompt(sessionID, {
        messageID: native,
        agent: "selected",
        model,
        variant: "default",
        parts: [{
          type: "text",
          text: "Explicitly resume after the chosen core point",
        }],
      });
      await oc.final(sessionID, native);
      const answer = await receive(incoming.id);
      assertEquals(provider.requests.length - before, 5);
      await proof("S18b", {
        sessionID,
        lostAnchor: sub.anchor_id,
        retainedIDsDeleted: ring.length,
        explicitAfterID: chosen.message_id,
        queuedHumanID: incoming.id,
        unchangedWhileBlocked: true,
        nativeNotification: "supported toast and native bus event",
        durableBlockedStateAtListConsumer: true,
        healthUserRows: 0,
        nativeAnswerID: answer.final.info.id,
        wakeRequests: 1,
      });
    },
  );

  await step(
    "S19 real member-added info is processed without native wake",
    async () => {
      const before = provider.requests.length;
      const incoming = await world.addMember(seed);
      assert(incoming.isInfo);
      await poll(() => roomState().recent_ids.includes(incoming.id), 15_000);
      assertEquals(provider.requests.length, before);
      assertEquals(await deliveryFor(incoming.id), undefined);
      await proof("S19", {
        sessionID,
        infoID: incoming.id,
        isInfo: true,
        providerRequests: 0,
        wakes: 0,
      });
    },
  );

  await step(
    "S21a room input cannot answer permission ask and waits for explicit operator reply",
    async () => {
      await disposeClean();
      await oc.configure({
        permission: { "*": "allow", fixture_send_message: "ask" },
      });
      await oc.start();
      await oc.api("/session/status");
      const before = provider.requests.length;
      provider.queue.push(
        {
          tool: {
            name: "fixture_send_message",
            args: { text: "S21 permission fixture" },
          },
        },
        { text: "S21 permission-approved native answer" },
        { text: "S21 queued human native answer" },
      );
      const first = await world.reply(
        `S21 ask turn ${crypto.randomUUID()}`,
        seed,
      );
      type Permission = { id: string; sessionID: string; permission: string };
      let permission: Permission | undefined;
      await poll(async () => {
        permission = (await oc.api<Permission[]>("/permission")).find((p) =>
          p.sessionID === sessionID
        );
        return !!permission;
      }, 30_000);
      assertEquals(permission!.permission, "fixture_send_message");
      const second = await world.reply(
        `S21 queued cannot approve ${crypto.randomUUID()}`,
        seed,
      );
      await waitQueued(second.id);
      assert(
        (await oc.api<Permission[]>("/permission")).some((p) =>
          p.id === permission!.id
        ),
      );
      assertEquals(provider.requests.length - before, 1);
      await oc.api(`/permission/${permission!.id}/reply`, "POST", {
        reply: "once",
      });
      const answers = [await receive(first.id), await receive(second.id)];
      assertEquals(provider.requests.length - before, 3);
      await proof("S21a", {
        sessionID,
        permissionID: permission!.id,
        incomingIDs: [first.id, second.id],
        retainedPendingAsk: true,
        runtimePermissionReplies: 0,
        queuedWakeRequests: 1,
        nativeAnswerIDs: answers.map((a) => a.final.info.id),
      });
      await disposeClean();
      await oc.configure({ permission: { "*": "allow" } });
      await oc.start();
      await oc.api("/session/status");
    },
  );

  await step(
    "S36 delayed original stays submitted beyond confirmation bound and never resubmits",
    async () => {
      const before = provider.requests.length;
      delay.armNextWake("hold");
      provider.queue.push({ text: "S36 delayed original native answer" });
      const incoming = await world.reply(
        `S36 delayed ${crypto.randomUUID()}`,
        seed,
      );
      let original = "";
      await poll(() => {
        original = [...delay.held.keys()][0] ?? "";
        return !!original;
      }, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 6500));
      const delivery = (await deliveryFor(incoming.id))!;
      assertEquals(delivery.state, "submitted");
      assertEquals(await oc.found(sessionID, original), undefined);
      assertEquals(
        (await query(
          "SELECT * FROM submission WHERE delivery_id=?",
          String(delivery.id),
        )).length,
        1,
      );
      assertEquals(provider.requests.length, before);
      delay.release(original);
      const answer = await receive(incoming.id);
      assertEquals(answer.wake.info.id, original);
      assertEquals(provider.requests.length - before, 1);
      await proof("S36", {
        sessionID,
        incomingID: incoming.id,
        originalID: original,
        nativeAnswerID: answer.final.info.id,
        providerRequests: 1,
        sameEpochSubmissions: 1,
        heldPastBoundMs: 6500,
      });
    },
  );

  await step(
    "S37 crash between204 and persistence retries stored IDs once in changed process",
    async () => {
      const before = provider.requests.length;
      delay.armNextWake("hold");
      const incoming = await world.reply(
        `S37 before persistence ${crypto.randomUUID()}`,
        seed,
      );
      let original = "";
      await poll(() => {
        original = [...delay.held.keys()][0] ?? "";
        return !!original;
      }, 30_000);
      await poll(async () =>
        (await deliveryFor(incoming.id))?.state === "submitted"
      );
      const delivery = (await deliveryFor(incoming.id))!;
      const prior = (await query(
        "SELECT * FROM submission WHERE delivery_id=?",
        String(delivery.id),
      ))[0];
      assertEquals(await oc.found(sessionID, original), undefined);
      await oc.stop("SIGKILL");
      delay.release(original);
      provider.queue.push({ text: "S37 recovered original native answer" });
      await oc.start();
      await oc.api("/session/status");
      const answer = await receive(incoming.id, sessionID, 120_000);
      const current = (await query(
        "SELECT * FROM submission WHERE delivery_id=?",
        String(delivery.id),
      ))[0];
      assertEquals(answer.wake.info.id, original);
      assertEquals(answer.wake.parts[0].id, prior.part_id);
      assertEquals(current.attempts, 2);
      assert(current.submit_epoch !== prior.submit_epoch);
      assertEquals(provider.requests.length - before, 1);
      await proof("S37", {
        sessionID,
        incomingID: incoming.id,
        originalID: original,
        partID: prior.part_id,
        attempts: 2,
        originalExited: true,
        changedEpoch: true,
        nativeAnswerID: answer.final.info.id,
        providerRequests: 1,
      });
    },
  );

  await step(
    "S38 forced admission error is visible and retries only after process restart",
    async () => {
      const before = provider.requests.length;
      delay.armNextWake("error");
      const incoming = await world.reply(
        `S38 rejected admission ${crypto.randomUUID()}`,
        seed,
      );
      await poll(
        async () =>
          (await deliveryFor(incoming.id))?.state === "admission_failed",
        15_000,
      );
      const delivery = (await deliveryFor(incoming.id))!;
      const prior = (await query(
        "SELECT * FROM submission WHERE delivery_id=?",
        String(delivery.id),
      ))[0];
      assertEquals(
        await oc.found(sessionID, String(prior.message_id)),
        undefined,
      );
      assertEquals(prior.attempts, 1);
      assertEquals(provider.requests.length, before);
      await disposeClean();
      provider.queue.push({ text: "S38 restarted native answer" });
      await oc.start();
      await oc.api("/session/status");
      const answer = await receive(incoming.id, sessionID, 120_000);
      const current = (await query(
        "SELECT * FROM submission WHERE delivery_id=?",
        String(delivery.id),
      ))[0];
      assertEquals(answer.wake.info.id, prior.message_id);
      assertEquals(answer.wake.parts[0].id, prior.part_id);
      assertEquals(current.attempts, 2);
      assertEquals(provider.requests.length - before, 1);
      await proof("S38", {
        sessionID,
        incomingID: incoming.id,
        originalID: prior.message_id,
        partID: prior.part_id,
        failedVisible: true,
        sameEpochAttempts: 1,
        restartedAttempts: 2,
        nativeAnswerID: answer.final.info.id,
        providerRequests: 1,
      });
    },
  );
}
