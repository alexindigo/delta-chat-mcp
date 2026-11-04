// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { poll } from "../../../tests/support.ts";
import { relayWorld } from "../../opencode/tests/support/relay_world.ts";
import { ProviderFixture } from "../../opencode/tests/support/provider_fixture.ts";
import { V2Process } from "../../opencode-v2/tests/support/process.ts";
import { InteractiveClaude } from "../../claude-code/tests/support/interactive.ts";
import {
  ClaudeProvider,
  type Reply,
} from "../../claude-code/tests/support/provider.ts";

/** Real native clients + stock encrypted peer. Requires the specifically
 * authorized terminal controller; model requests stay scripted and local. */
export async function handoff() {
  const run = Deno.env.get("CONVERSATION_EVIDENCE_DIR"),
    tmp = Deno.env.get("TMPDIR");
  if (!run?.startsWith("/") || !tmp || tmp === "/tmp") {
    throw new Error("Explicit private evidence and disk TMPDIR required");
  }
  await Deno.mkdir(run, { mode: 0o700 });
  const facts: Record<string, unknown> = {};
  const errors: unknown[] = [];
  let operation:
    | { name: string; args: Record<string, unknown>; done: boolean }
    | undefined;
  let compacting = false;
  let held: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let holdNext = false;
  let prefix = "mcp__plugin_delta-chat_relay__chat_";
  let stage = "setup";
  const provider = new ClaudeProvider((body): Reply => {
    const messages = Array.isArray(body.messages)
      ? body.messages as { role: string; content: unknown }[]
      : [];
    // Suggestion-mode agents can receive the same tool catalog as the main
    // turn. They must not consume that turn's scripted response. The failed
    // prototype captured this exact native utility prompt and its tool refusal.
    if (
      messages.some((m) =>
        m.role === "user" && typeof m.content === "string" &&
        m.content.startsWith("[SUGGESTION MODE:")
      )
    ) return { text: "" };
    const tools = Array.isArray(body.tools)
      ? body.tools as { name: string }[]
      : [];
    const primary = tools.some((t) => t.name.startsWith(prefix));
    if (compacting) {
      return {
        text:
          "<analysis>Private explicit-reply qualification. Preserve the room and use tools for replies.</analysis><summary>The fixture has subscribed to its CI room and replied explicitly. Continue the isolated qualification. Delta Chat retains earlier chat context.</summary>",
      };
    }
    if (!primary) return { text: "Private room qualification" };
    if (holdNext) {
      holdNext = false;
      return {
        text: "INTERRUPTED_TERMINAL_MUST_NOT_SEND",
        hold: held!.promise,
      };
    }
    if (operation && !operation.done) {
      operation.done = true;
      return { tool: { name: prefix + operation.name, input: operation.args } };
    }
    return { text: `TERMINAL_ONLY_${stage}` };
  });
  const v2Provider = new ProviderFixture();
  let world: Awaited<ReturnType<typeof relayWorld>> | undefined;
  let proxy: Deno.HttpServer<Deno.NetAddr> | undefined;
  let loseSendReceipt = false, lostReceipts = 0;
  let v2: V2Process | undefined;
  let claude: InteractiveClaude | undefined;
  let v2Session: string | undefined;
  const setTool = (name: string, args: Record<string, unknown>) => {
    operation = { name, args, done: false };
  };
  const phase = async (value: Record<string, unknown>) => {
    if (claude) await claude.phase({ stage, ...value });
    else {await Deno.writeTextFile(
        `${run}/phase.json`,
        JSON.stringify({ stage, generation: -1, ...value }),
        { mode: 0o600 },
      );}
  };
  try {
    await phase({ phase: "provisioning-ci-peer" });
    world = await relayWorld();
    const upstream = world.first.config.url;
    proxy = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const body = request.method === "POST"
          ? await request.clone().json().catch(() => undefined)
          : undefined;
        const response = await fetch(new Request(new URL(upstream), request));
        if (
          loseSendReceipt && body?.method === "tools/call" &&
          body.params?.name === "send_message"
        ) {
          loseSendReceipt = false;
          lostReceipts++;
          await response.body?.cancel();
          return new Response("Fixture lost the accepted send receipt", {
            status: 502,
          });
        }
        return response;
      },
    );
    const relay = {
      url: `http://127.0.0.1:${proxy.addr.port}/mcp`,
      headers: world.first.config.headers,
    };
    v2 = await V2Process.create(`${run}/v2`, v2Provider, relay);
    await v2.start();
    v2Session = await v2.session();
    const seed = `handoff-seed-${crypto.randomUUID()}`;
    await world.tool(world.first.client, "send_message", {
      chat_id: world.room,
      text: seed,
    });
    await world.receivesComplete(seed);
    await v2.tool(v2Session, "room_subscribe", { chat_id: world.room });
    claude = await InteractiveClaude.create(run, provider.url, relay);
    prefix = claude.prefix;
    stage = "subscribe";
    setTool("room_subscribe", { chat_id: world.room });
    await claude.start();
    await claude.input(
      `Subscribe to the private CI room using chat_room_subscribe with chat_id ${world.room}, then finish in the terminal.`,
    );
    const keyOwner = world.first.service.app.apiKeys.list()[0].id;
    assert(typeof keyOwner === "string");
    const routing = world.first.service.app.routing!;
    await poll(
      () =>
        routing.subscriptions(keyOwner, claude!.session).subscriptions.some((
          s,
        ) => s.recipient),
      30000,
    );
    await claude.idle();

    const firstReply = ("Complete encrypted Claude reply.\n".repeat(310))
      .trimEnd();
    stage = "claude-first";
    setTool("send_message", { chat_id: world.room, text: firstReply });
    await phase({ phase: "awaiting-encrypted-claude-reply" });
    const firstInput = await world.quotedReply(
      `Quoted provenance question ${crypto.randomUUID()}`,
      seed,
    );
    const peerFirst = await world.receivesComplete(firstReply);
    await poll(
      () =>
        routing.inbox(keyOwner).deliveries.some((d) =>
          d.message_ids.includes(firstInput.id) &&
          d.outcome === "answered_by_model"
        ),
      15000,
    );
    assertEquals(
      (await v2.messages(v2Session)).filter((m) => m.metadata?.deltachat)
        .length,
      0,
    );
    const firstDelivery = claude.db.get(
      "SELECT * FROM channel_delivery WHERE session=?",
      claude.session,
    )!;
    const firstRequest = provider.requests.find((r) =>
      JSON.stringify(r.messages).includes(String(firstDelivery.nonce))
    );
    assert(
      firstRequest &&
        JSON.stringify(firstRequest.messages).includes(
          "J4 canonical peer override",
        ),
    );
    assert(JSON.stringify(firstRequest.messages).includes(seed));
    facts.claudeEncrypted = peerFirst.showPadlock;
    facts.claudeFullBody = peerFirst.body === firstReply;

    // Long bodies are checked independently of the quote-aware core view. A
    // short quoted row proves canonical quote/sender facts without equating its
    // complete plaintext (which can include the quote) with unquoted source text.
    stage = "claude-busy";
    operation = undefined;
    held = Promise.withResolvers<void>();
    holdNext = true;
    await claude.input(
      "Run the private held-response busy-batch qualification.",
    );
    await poll(() => !holdNext, 10000);
    const beforeBatch = claude.db.all("SELECT id FROM channel_delivery").length;
    const longBody = "Complete long encrypted batch input.\n".repeat(310)
      .trimEnd();
    const batchA = await world.reply(longBody, seed);
    const batchB = await world.reply(
      `Second batched input ${crypto.randomUUID()}`,
      seed,
    );
    await poll(
      () =>
        routing.inbox(keyOwner).deliveries.some((d) =>
          d.state === "ready" && d.message_ids.includes(batchA.id) &&
          d.message_ids.includes(batchB.id)
        ),
      10000,
    );
    assertEquals(
      claude.db.all("SELECT id FROM channel_delivery").length,
      beforeBatch,
    );
    stage = "claude-batch-reply";
    setTool("send_message", {
      chat_id: world.room,
      text: "CLAUDE_ENCRYPTED_BATCH_REPLY",
    });
    held.resolve();
    await world.receivesComplete("CLAUDE_ENCRYPTED_BATCH_REPLY");
    await claude.idle();
    const batchDelivery = claude.db.all("SELECT * FROM channel_delivery").find((
      d,
    ) => (JSON.parse(String(d.ids)) as number[]).includes(batchA.id))!;
    assertEquals(JSON.parse(String(batchDelivery.ids)), [batchA.id, batchB.id]);
    const batchRequest = provider.requests.find((r) =>
      JSON.stringify(r.messages).includes(String(batchDelivery.nonce))
    )!;
    const texts =
      (batchRequest.messages as { content: string | { text?: string }[] }[])
        .flatMap((m) =>
          typeof m.content === "string"
            ? [m.content]
            : m.content.flatMap((p) => p.text ? [p.text] : [])
        );
    assert(texts.some((t) => t.includes(JSON.stringify(longBody))));
    facts.claudeBusyBatching = true;
    facts.longInputComplete = true;

    stage = "forwarded";
    setTool("send_message", {
      chat_id: world.room,
      text: "CLAUDE_ENCRYPTED_FORWARDED_REPLY",
    });
    const forwarded = await world.forwardedReply(seed);
    await world.receivesComplete("CLAUDE_ENCRYPTED_FORWARDED_REPLY");
    await claude.idle();
    const forwardDelivery = claude.db.all("SELECT * FROM channel_delivery")
      .find((d) =>
        (JSON.parse(String(d.ids)) as number[]).includes(forwarded.id)
      )!;
    const forwardRequest = provider.requests.find((r) =>
      JSON.stringify(r.messages).includes(String(forwardDelivery.nonce))
    )!;
    assert(
      JSON.stringify(forwardRequest.messages).includes(
        '\\"isForwarded\\":true',
      ),
    );
    facts.forwardedFacts = true;

    stage = "v2-recipient";
    operation = undefined;
    await v2.tool(v2Session, "read_messages", {
      chat_id: world.room,
      limit: 20,
    });
    assert(
      routing.subscriptions(keyOwner, v2Session).subscriptions[0].recipient,
    );
    const claudeCount = claude.db.all("SELECT id FROM channel_delivery").length;
    const secondReply = "V2_ENCRYPTED_EXPLICIT_HANDOFF_REPLY";
    v2.queueTool(
      "send_message",
      { chat_id: world.room, text: secondReply },
      "V2_TERMINAL_ONLY",
    );
    await world.reply(`v2-input-${crypto.randomUUID()}`, seed);
    const peerSecond = await world.receivesComplete(secondReply);
    await v2.idle(v2Session);
    assertEquals(
      claude.db.all("SELECT id FROM channel_delivery").length,
      claudeCount,
    );
    assertEquals(
      (await v2.messages(v2Session)).filter((m) => m.metadata?.deltachat)
        .length,
      1,
    );
    facts.v2Encrypted = peerSecond.showPadlock;
    facts.onlySelectedRecipient = true;

    stage = "compact";
    compacting = true;
    const compactBefore = (await claude.hooks()).filter((h) =>
      h.event === "PostCompact"
    ).length;
    await claude.input(
      "/compact Preserve the private room qualification state.",
    );
    await poll(async () =>
      (await claude!.hooks()).filter((h) => h.event === "PostCompact").length >
        compactBefore, 30000);
    compacting = false;
    stage = "interest-back";
    setTool("read_messages", { chat_id: world.room, limit: 20 });
    await claude.input(
      `Read the private room with chat_read_messages, chat_id ${world.room}, then finish in the terminal.`,
    );
    await poll(() =>
      routing.subscriptions(keyOwner, claude!.session).subscriptions[0]
        .recipient, 30000);
    await claude.idle();
    stage = "post-compact";
    setTool("send_message", {
      chat_id: world.room,
      text: "CLAUDE_POST_COMPACT_ENCRYPTED_REPLY",
    });
    await world.reply(`compact-input-${crypto.randomUUID()}`, seed);
    await world.receivesComplete("CLAUDE_POST_COMPACT_ENCRYPTED_REPLY");
    await claude.idle();
    facts.postCompactionReply = true;

    stage = "uncertain-send";
    setTool("send_message", {
      chat_id: world.room,
      text: "UNCERTAIN_RECEIPT_ENCRYPTED_REPLY",
    });
    loseSendReceipt = true;
    const uncertainInput = await world.reply(
      `Uncertain send receipt ${crypto.randomUUID()}`,
      seed,
    );
    await world.receivesComplete("UNCERTAIN_RECEIPT_ENCRYPTED_REPLY");
    await poll(() =>
      routing.inbox(keyOwner).deliveries.some((d) =>
        d.message_ids.includes(uncertainInput.id) && d.outcome === "stalled"
      ), 15000);
    await claude.idle();
    assertEquals(lostReceipts, 1);
    assert(
      claude.db.all("SELECT * FROM channel_send").some((s) =>
        s.state === "uncertain" && s.core_id === null
      ),
    );
    facts.unknownSendNotRetried = true;

    stage = "restart";
    await claude.stop();
    const restartInput = await world.reply(
      `offline-backlog-${crypto.randomUUID()}`,
      seed,
    );
    await poll(() =>
      routing.inbox(keyOwner).deliveries.some((d) =>
        d.state === "ready" && d.message_ids.includes(restartInput.id)
      ), 10000);
    setTool("send_message", {
      chat_id: world.room,
      text: "CLAUDE_RESUMED_BACKLOG_ENCRYPTED_REPLY",
    });
    await claude.start(true);
    await world.receivesComplete("CLAUDE_RESUMED_BACKLOG_ENCRYPTED_REPLY");
    await claude.idle();
    facts.ordinaryResumeCatchup = true;

    stage = "interrupt";
    operation = undefined;
    held = Promise.withResolvers<void>();
    holdNext = true;
    const cancellationCount = provider.cancelled.length;
    const interrupted = await world.reply(
      `interrupt-input-${crypto.randomUUID()}`,
      seed,
    );
    await poll(() =>
      !!claude!.db.get(
        "SELECT 1 FROM channel_delivery WHERE session=? AND state='observed' AND ids LIKE ?",
        claude!.session,
        `%${interrupted.id}%`,
      ), 30000);
    await poll(() =>
      !holdNext, 10000);
    await claude.escape();
    await poll(() =>
      provider.cancelled.length > cancellationCount, 10000);
    held.resolve();
    stage = "native-continue";
    const promptsBefore = (await claude.hooks()).filter((h) =>
      h.event === "UserPromptSubmit"
    ).length;
    await claude.input(
      "Continue the private qualification with a terminal-only response.",
    );
    await poll(async () =>
      (await claude!.hooks()).filter((h) =>
        h.event === "UserPromptSubmit"
      ).length > promptsBefore, 15000);
    await poll(() =>
      routing.inbox(keyOwner).deliveries.some((d) =>
        d.message_ids.includes(interrupted.id) &&
        d.outcome === "superseded_by_native_input"
      ), 15000);
    await claude.idle();
    stage = "after-interrupt";
    setTool("send_message", {
      chat_id: world.room,
      text: "CLAUDE_AFTER_NATIVE_CONTINUE",
    });
    await world.reply(`after-interrupt-${crypto.randomUUID()}`, seed);
    await world.receivesComplete("CLAUDE_AFTER_NATIVE_CONTINUE");
    await claude.idle();
    facts.interruptionDoesNotReplay = true;

    stage = "leave";
    setTool("room_leave", { chat_id: world.room });
    await claude.input(
      `Leave this subscription using chat_room_leave with chat_id ${world.room}, then finish in the terminal.`,
    );
    await poll(() =>
      !routing.subscriptions(keyOwner, claude!.session).subscriptions[0]
        .subscribed, 30000);
    await claude.idle();
    const afterLeaveCount =
      claude.db.all("SELECT id FROM channel_delivery").length;
    v2.queueTool("send_message", {
      chat_id: world.room,
      text: "V2_AFTER_CLAUDE_LEAVE",
    }, "V2_LEAVE_TERMINAL");
    await world.reply(`after-leave-${crypto.randomUUID()}`, seed);
    await world.receivesComplete("V2_AFTER_CLAUDE_LEAVE");
    await v2.idle(v2Session);
    assertEquals(
      claude.db.all("SELECT id FROM channel_delivery").length,
      afterLeaveCount,
    );
    facts.explicitLeave = true;

    const peerMessages = await world.completePeerMessages();
    for (
      const text of [
        firstReply,
        "CLAUDE_ENCRYPTED_BATCH_REPLY",
        "CLAUDE_ENCRYPTED_FORWARDED_REPLY",
        secondReply,
        "CLAUDE_POST_COMPACT_ENCRYPTED_REPLY",
        "UNCERTAIN_RECEIPT_ENCRYPTED_REPLY",
        "CLAUDE_RESUMED_BACKLOG_ENCRYPTED_REPLY",
        "CLAUDE_AFTER_NATIVE_CONTINUE",
        "V2_AFTER_CLAUDE_LEAVE",
      ]
    ) {
      assertEquals(
        peerMessages.filter((m) =>
          m.body === text && m.showPadlock
        ).length,
        1,
      );
    }
    assert(
      !peerMessages.some((m) =>
        m.body?.startsWith("TERMINAL_ONLY_") ||
        m.body === "INTERRUPTED_TERMINAL_MUST_NOT_SEND"
      ),
    );
    assertEquals(v2Provider.unexpected, []);
    assert(provider.unexpected.every((p) =>
      p === "/api/hello"
    ));
    facts.packagedPlugin = true;
    facts.uniqueEncryptedReplies = 9;
    facts.terminalAnswersNotMirrored = true;
    await Deno.writeTextFile(
      `${run}/result.json`,
      JSON.stringify(
        { ...facts, claudeSession: claude.session, v2Session, peerMessages },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await phase({ phase: "complete" });
  } catch (error) {
    errors.push(error);
    try {
      await Deno.writeTextFile(
        `${run}/failure.json`,
        JSON.stringify(
          {
            stage,
            facts,
            error: String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (evidenceError) {
      errors.push(evidenceError);
    }
  } finally {
    held?.resolve();
    try {
      if (claude) {
        await Deno.writeTextFile(
          `${run}/claude-progress.json`,
          JSON.stringify(
            {
              deliveries: claude.db.all("SELECT * FROM channel_delivery"),
              sends: claude.db.all("SELECT * FROM channel_send"),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await Deno.writeTextFile(
        `${run}/provider-facts.json`,
        JSON.stringify(
          {
            stage,
            claude: {
              requests: provider.requests,
              unexpected: provider.unexpected,
              cancelled: provider.cancelled,
            },
            v2: {
              requests: v2Provider.requests,
              unexpected: v2Provider.unexpected,
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      if (v2 && v2Session) {
        await Deno.writeTextFile(
          `${run}/v2-messages.json`,
          JSON.stringify(await v2.messages(v2Session), null, 2),
          { mode: 0o600 },
        );
      }
    } catch (error) {
      errors.push(error);
    }
    const closed = await Promise.allSettled([claude?.close(), v2?.stop()]);
    const resources = await Promise.allSettled([
      provider.close(),
      v2Provider.close(),
      proxy?.shutdown(),
      world?.close(),
    ]);
    for (const result of [...closed, ...resources]) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      "Native qualification or evidence collection failed; inspect the private artifacts",
    );
  }
}
if (import.meta.main) await handoff();
