// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { deadline, poll } from "../../../tests/support.ts";
import { fingerprint } from "../mirror.ts";
import { openSqlite } from "../sqlite.ts";
import { object } from "../types.ts";
import { ProviderFixture } from "./support/provider_fixture.ts";
import { McpFixture } from "./support/mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./support/opencode_process.ts";
import { relayWorld } from "./support/relay_world.ts";

/** Private fault after the real service accepts the explicit send. Same
 * truncated-SSE failure shape as S29b; no SDK or fixture defaults change. */
function lostModelReceipt(
  upstream: string,
  before: (body: Record<string, unknown>, request: Request) => Promise<void>,
) {
  const lifetime = new AbortController();
  let sends = 0, dropped = 0, mirrors = 0;
  const http = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: lifetime.signal,
    onListen() {},
  }, async (request) => {
    const body = request.method === "POST"
      ? await request.clone().json().catch(() => undefined)
      : undefined;
    const tool = body?.method === "tools/call" ? body.params?.name : undefined;
    if (tool === "inbox_mirror") mirrors++;
    if (tool === "send_message") {
      await before(body, request);
      sends++;
    }
    const response = await fetch(new Request(upstream, request));
    if (tool !== "send_message") return response;
    assertEquals(response.status, 200);
    await response.arrayBuffer();
    dropped++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("event: message\ndata: "));
          setTimeout(
            () => c.error(new Error("model-receipt-owned-response-loss")),
            20,
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return {
    url: `http://127.0.0.1:${http.addr.port}/mcp`,
    get sends() {
      return sends;
    },
    get dropped() {
      return dropped;
    },
    get mirrors() {
      return mirrors;
    },
    async close() {
      lifetime.abort();
      await deadline(http.finished, 15_000);
    },
  };
}

Deno.test("native explicit different-key send loses its real receipt: one complete peer body, retained final and mirror_uncertain", async () => {
  const provider = new ProviderFixture(),
    mcp = new McpFixture(),
    delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  let world: Awaited<ReturnType<typeof relayWorld>> | undefined;
  let wire: ReturnType<typeof lostModelReceipt> | undefined;
  const state = `${oc.root}/model-proof/progress.sqlite`;
  const query = async (sql: string, ...args: (string | number)[]) => {
    const db = await openSqlite(state, true);
    try {
      return db.all(sql, ...args);
    } finally {
      db.close();
    }
  };
  try {
    world = await relayWorld();
    const routing = world.first.service.app.routing!;
    const firstOwner = String(world.first.service.app.apiKeys.list()[0].id);
    const secondKey = await world.first.service.app.apiKeys.create(
      "explicit model second key",
    );
    const claimURI = `deltachat://inbox/${routing.namespace(firstOwner)}`;
    const modelURI = `deltachat://inbox/${routing.namespace(secondKey.id)}`;
    assert(claimURI !== modelURI);
    let sessionID = "", boundPart: Record<string, unknown> | undefined;
    wire = lostModelReceipt(world.first.config.url, async (body, request) => {
      assertEquals(
        await world!.first.service.app.apiKeys.authenticate(request),
        secondKey.id,
      );
      assertEquals(
        object(object(body.params)._meta)["ai.opencode/sessionID"],
        sessionID,
      );
      const attempts = await query("SELECT * FROM model_send_attempt");
      assertEquals(attempts.length, 1);
      const attempt = attempts[0];
      assertEquals(attempt.status, "pending");
      assertEquals(attempt.core_id, null);
      const rows = await oc.messages(sessionID);
      const assistant = rows.find((r) =>
        r.info.id === attempt.native_message_id
      );
      assert(assistant);
      const part = assistant.parts.find((p) => p.id === attempt.native_part_id);
      assert(part);
      assertEquals(part.tool, "manual_send_message");
      assertEquals(part.state?.status, "running");
      assertEquals(object(part).callID, attempt.call_id);
      const submission = (await query(
        "SELECT * FROM submission WHERE delivery_id=?",
        String(attempt.delivery_id),
      ))[0];
      assertEquals(assistant.info.parentID, submission.message_id);
      const wake = rows.find((r) => r.info.id === submission.message_id);
      assert(wake);
      assertEquals(
        object(
          wake.parts.find((p) => p.id === submission.part_id)?.metadata
            ?.deltaChatWake,
        ).deliveryId,
        attempt.delivery_id,
      );
      assertEquals(
        (await query(
          "SELECT inbox_uri FROM delivery_edge WHERE delivery_id=?",
          String(attempt.delivery_id),
        ))[0].inbox_uri,
        claimURI,
      );
      boundPart = {
        messageID: assistant.info.id,
        partID: part.id,
        callID: attempt.call_id,
        wakeID: submission.message_id,
        deliveryID: attempt.delivery_id,
      };
    });
    await oc.configure({
      plugin: [[
        new URL("../dist/delta-chat-mcp-opencode.js", import.meta.url).href,
        {
          relays: {
            relay: {
              url: wire.url,
              headers: world.first.config.headers,
              enabled: true,
            },
            manual: {
              url: wire.url,
              headers: { Authorization: `Bearer ${secondKey.key}` },
              enabled: true,
            },
          },
          stateFile: state,
        },
      ]],
      mcp: {},
    });
    await oc.start();
    const session = await oc.session("explicit second-key lost receipt");
    sessionID = session.id;
    const seed = `model-proof seed ${crypto.randomUUID()}`;
    await world.tool(world.first.client, "send_message", {
      chat_id: world.room,
      text: seed,
    });
    await world.receives(seed);
    provider.queue.push({
      tool: { name: "relay_room_subscribe", args: { chat_id: world.room } },
    }, { text: "main channel subscription result" });
    const native = `msg_modelproof${crypto.randomUUID().replaceAll("-", "")}`;
    await oc.prompt(sessionID, {
      messageID: native,
      model: { providerID: "test", modelID: "test-model" },
      parts: [{
        type: "text",
        text: "Subscribe with the configured relay tool.",
      }],
    });
    await oc.final(sessionID, native);
    const subscription = (await oc.messages(sessionID)).flatMap((r) => r.parts)
      .findLast((p) => p.tool === "relay_room_subscribe");
    assertEquals(subscription?.state?.status, "completed");
    assert(!JSON.parse(subscription!.state!.output!).isError);
    const answer =
      `different-key actual native answer ${crypto.randomUUID()}\n\n${
        "Complete logical body α & < >. ".repeat(260)
      }\nEND-model-proof`;
    const hash = await fingerprint(answer);
    provider.queue.push({
      tool: {
        name: "manual_send_message",
        args: { chat_id: world.room, text: answer },
      },
    }, { text: answer });
    const incoming = await world.quotedReply(
      `model-proof incoming ${crypto.randomUUID()}`,
      seed,
    );
    let delivery: Record<string, unknown> | undefined;
    await poll(async () => {
      delivery =
        (await query("SELECT * FROM delivery WHERE session_id=?", sessionID))
          .find((d) =>
            (JSON.parse(String(d.message_ids)) as number[]).includes(
              incoming.id,
            )
          );
      return delivery?.state === "mirror_uncertain";
    }, 60_000);
    assert(delivery);
    assert(boundPart);
    const final = await oc.final(sessionID, String(boundPart.wakeID));
    assertEquals(
      final.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) =>
        p.text
      ).join("\n\n"),
      answer,
    );
    const peer = await world.receivesComplete(answer);
    assertEquals(peer.body, answer);
    assert(peer.showPadlock);
    const receipt = (await query(
      "SELECT * FROM model_send_attempt WHERE delivery_id=?",
      String(delivery.id),
    ))[0];
    assertEquals(receipt.status, "uncertain");
    assertEquals(receipt.core_id, null);
    assertEquals(receipt.fingerprint, hash);
    assertEquals(receipt.native_message_id, boundPart.messageID);
    assertEquals(receipt.native_part_id, boundPart.partID);
    assertEquals(receipt.call_id, boundPart.callID);
    assertEquals(JSON.parse(String(delivery.model_sent_ids)), []);
    assertEquals(JSON.parse(String(delivery.mirror_message_ids)), []);
    assertEquals(
      (await query(
        "SELECT * FROM model_send WHERE delivery_id=?",
        String(delivery.id),
      )).length,
      0,
    );
    assertEquals(
      (await query(
        "SELECT * FROM mirror_progress WHERE delivery_id=?",
        String(delivery.id),
      )).length,
      0,
    );
    await poll(
      () =>
        routing.inbox(firstOwner).deliveries.some((d) =>
          d.delivery_id === delivery!.id && d.state === "completed" &&
          d.outcome === "mirror_uncertain"
        ),
      30_000,
    );
    assertEquals(
      (await world.first.service.app.chats.messages(world.room, { limit: 100 }))
        .filter((m) => m.fromSelf && m.text === answer).length,
      1,
    );
    assertEquals(
      (await world.completePeerMessages()).filter((m) => m.body === answer)
        .length,
      1,
    );
    assertEquals(wire.sends, 1);
    assertEquals(wire.dropped, 1);
    assertEquals(wire.mirrors, 0);
    await oc.api("/instance/dispose", "POST");
    await oc.api("/session/status");
    assert(
      (await oc.messages(sessionID)).some((r) => r.info.id === final.info.id),
    );
    await oc.api("/instance/dispose", "POST");
    assertEquals(
      (await world.completePeerMessages()).filter((m) => m.body === answer)
        .length,
      1,
    );
    assertEquals(wire.sends, 1);
    assertEquals(wire.mirrors, 0);
    assertEquals(
      (await query(
        "SELECT inbox_uri FROM delivery_edge WHERE delivery_id=?",
        String(delivery.id),
      ))[0].inbox_uri,
      claimURI,
    );
    assertEquals(provider.queue.length, 0);
    assertEquals(provider.unexpected, []);
    assertEquals(provider.requests.length, 4);
    const proof = {
      scenario: "explicit-model-different-key-uncertain",
      version: await oc.version(),
      incomingID: incoming.id,
      nativeFinalID: final.info.id,
      ...boundPart,
      distinctNamespaces: claimURI !== modelURI,
      frozenClaimURI: claimURI,
      modelURI,
      explicitSends: wire.sends,
      lostReceipts: wire.dropped,
      automaticMirrors: wire.mirrors,
      peerMessageID: peer.id,
      completePeerBodyCount: 1,
      bodyLength: answer.length,
      fingerprint: hash,
      nativeFinalRetained: true,
      outcome: delivery.state,
      modelReceipt: receipt.status,
      modelCoreID: receipt.core_id,
      providerRequests: provider.requests.length,
    };
    await Deno.writeTextFile(
      `${oc.root}/model-send-consumer-proof.json`,
      JSON.stringify(proof, null, 2),
      { createNew: true, mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        modelSendConsumerProof: proof,
        evidence: `${oc.root}/model-send-consumer-proof.json`,
      }),
    );
  } finally {
    await oc.close();
    await wire?.close();
    await world?.close();
    await delay.close();
    await mcp.close();
    await provider.close();
  }
});
