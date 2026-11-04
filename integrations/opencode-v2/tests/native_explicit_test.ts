// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { ProviderFixture } from "../../opencode/tests/support/provider_fixture.ts";
import { nativeID } from "../../opencode/registry.ts";
import {
  roomMessage,
  routingFixture,
} from "../../../tests/room_routing_support.ts";
import { deadline, poll } from "../../../tests/support.ts";

interface NativeMessage {
  id: string;
  type: string;
  metadata?: { deltachat?: unknown };
  text?: string;
  content?: { text?: string }[];
  status?: string;
}

Deno.test("OpenCode 2.2.5: real Code Mode explicit replies, busy batching, interruption, compaction and restart", async () => {
  const binary = Deno.env.get("OPENCODE_V2_BIN");
  const tmp = Deno.env.get("TMPDIR");
  if (!binary || !tmp || tmp === "/tmp") {
    throw new Error("Explicit native binary and disk TMPDIR required");
  }
  const run = await Deno.makeTempDir({ dir: tmp, prefix: "v2-explicit-" });
  for (
    const name of [
      "home",
      "config",
      "data",
      "state",
      "cache",
      "project",
      "config/opencode",
    ]
  ) await Deno.mkdir(`${run}/${name}`, { recursive: true, mode: 0o700 });
  const f = await routingFixture();
  const provider = new ProviderFixture();
  const relayHTTP = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, (req) => f.fetcher(req));
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  const password = crypto.randomUUID();
  const env = {
    PATH: "/opt/claude-experiments/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: `${run}/home`,
    XDG_CONFIG_HOME: `${run}/config`,
    XDG_DATA_HOME: `${run}/data`,
    XDG_STATE_HOME: `${run}/state`,
    XDG_CACHE_HOME: `${run}/cache`,
    TMPDIR: tmp,
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  };
  const config = {
    update: "disable",
    share: "disabled",
    snapshots: false,
    model: "test/test-model",
    formatter: false,
    lsp: false,
    provider: provider.config().provider,
    plugins: [{
      package: new URL("../", import.meta.url).href,
      options: {
        stateFile: `${run}/progress.sqlite`,
        relays: {
          chat: {
            url: `http://127.0.0.1:${relayHTTP.addr.port}/mcp`,
            enabled: true,
            headers: { Authorization: `Bearer ${f.first.key}` },
          },
        },
      },
    }],
  };
  await Deno.writeTextFile(
    `${run}/config/opencode/opencode.json`,
    JSON.stringify(config),
    { mode: 0o600 },
  );
  let child: Deno.ChildProcess | undefined;
  let logs: Promise<unknown>[] = [];
  let launch = 0;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Basic ${btoa(`opencode:${password}`)}`,
        "content-type": "application/json",
        "x-opencode-directory": `${run}/project`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Native API ${path} HTTP${response.status}: ${text.slice(0, 300)}`,
      );
    }
    return text ? JSON.parse(text) : undefined;
  };
  const start = async () => {
    const n = launch++;
    const stdout = await Deno.open(`${run}/native-${n}.stdout`, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    const stderr = await Deno.open(`${run}/native-${n}.stderr`, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    child = new Deno.Command(binary, {
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: `${run}/project`,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    logs = [
      child.stdout.pipeTo(stdout.writable),
      child.stderr.pipeTo(stderr.writable),
    ];
    await poll(async () => {
      try {
        return (await api("/api/info")).version === "2.2.5";
      } catch {
        return false;
      }
    }, 30000);
    await api("/api/agent");
  };
  const stop = async () => {
    if (!child) return;
    const owned = child;
    child = undefined;
    owned.kill("SIGTERM");
    await deadline(Promise.all([owned.status, ...logs]), 15000);
  };
  const messages = async (id: string): Promise<NativeMessage[]> =>
    (await api(`/api/session/${id}/message?limit=100&order=asc`)).data;
  const idle = async (id: string) =>
    await poll(async () => !(await api("/api/session/active")).data[id], 30000);
  const tool = (name: string, args: unknown) => ({
    tool: {
      name: "execute",
      args: {
        code: `return await tools["chat"].${name}(${JSON.stringify(args)});`,
      },
    },
  });
  const incomingRows = async (id: string) =>
    (await messages(id)).filter((m) =>
      m.type === "user" && m.metadata?.deltachat
    );
  let held: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let sessionID: string | undefined;
  try {
    await start();
    const session = (await api("/api/session", {
      title: "Explicit reply qualification",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      location: { directory: `${run}/project` },
      permissions: [{ action: "chat_*", resource: "*", effect: "allow" }],
    })).data;
    sessionID = session.id;
    provider.queue.push(tool("room_subscribe", { chat_id: 42 }), {
      text: "MAIN_ONLY",
    });
    await api(`/api/session/${session.id}/prompt`, {
      id: nativeID("msg"),
      text: "Call the specified private room tool.",
    });
    await poll(
      async () =>
        (await messages(session.id)).some((m) =>
          m.type === "assistant" &&
          m.content?.some((p) => p.text === "MAIN_ONLY")
        ),
      30000,
    );
    await idle(session.id);
    assertEquals(
      f.routing.subscriptions(f.first.id, session.id).subscriptions.length,
      1,
    );
    const reply = "exact explicit chat reply\n".repeat(300);
    provider.queue.push(tool("send_message", { chat_id: 42, text: reply }), {
      text: "TERMINAL_ONLY",
    });
    f.incoming(
      roomMessage(11, {
        text: "native full-body\n".repeat(500),
        isForwarded: true,
        quote: { text: "native quote", authorName: "Peer original" },
      }),
    );
    await poll(() => f.sent.some((s) => s.text === reply), 30000);
    await idle(session.id);
    const inputs = await incomingRows(session.id);
    assertEquals(inputs.length, 1);
    const frame = inputs[0].text;
    assert(typeof frame === "string");
    assert(
      frame.includes("native quote") && frame.includes('"isForwarded":true'),
    );
    assert(frame.includes('tools["chat"].send_message'));
    assert(frame.includes('tools["chat"].read_messages'));
    assert(frame.includes('tools["chat"].room_leave'));
    await poll(
      () =>
        f.routing.inbox(f.first.id).deliveries.some((d) =>
          d.outcome === "answered_by_model"
        ),
      10000,
    );
    assertEquals(f.sent.filter((s) => s.text === reply).length, 1);
    assert(
      !f.sent.some((s) => ["MAIN_ONLY", "TERMINAL_ONLY"].includes(s.text)),
    );

    provider.queue.push({ text: "UNSENT_TERMINAL_ANSWER" });
    f.incoming(roomMessage(12));
    await poll(
      async () => (await incomingRows(session.id)).length === 2,
      30000,
    );
    await idle(session.id);
    await poll(
      () =>
        f.routing.inbox(f.first.id).deliveries.some((d) =>
          d.message_ids.includes(12) && d.outcome === "empty"
        ),
      10000,
    );
    assert(!f.sent.some((s) => s.text === "UNSENT_TERMINAL_ANSWER"));

    held = Promise.withResolvers<void>();
    provider.queue.push({
      text: "BUSY_MAIN_ONLY",
      hold: held.promise,
      holdSilent: true,
    });
    await api(`/api/session/${session.id}/prompt`, {
      id: nativeID("msg"),
      text: "Private busy turn.",
    });
    await poll(() => provider.queue.length === 0, 30000);
    f.incoming(roomMessage(13), roomMessage(14));
    await poll(
      () =>
        f.routing.inbox(f.first.id).deliveries.some((d) =>
          d.state === "ready" && d.message_ids.includes(13) &&
          d.message_ids.includes(14)
        ),
      10000,
    );
    assertEquals((await incomingRows(session.id)).length, 2);
    provider.queue.push(
      tool("send_message", { chat_id: 42, text: "BATCH_REPLY" }),
      { text: "BATCH_TERMINAL" },
    );
    held.resolve();
    await poll(() => f.sent.some((s) => s.text === "BATCH_REPLY"), 30000);
    await idle(session.id);

    held = Promise.withResolvers<void>();
    provider.queue.push({
      text: "MUST_NOT_MIRROR_INTERRUPTED",
      hold: held.promise,
      holdSilent: true,
    });
    f.incoming(roomMessage(15));
    await poll(
      async () => (await incomingRows(session.id)).length === 4,
      30000,
    );
    await api(`/api/session/${session.id}/interrupt`, {});
    held.resolve();
    await idle(session.id);
    await poll(
      () =>
        f.routing.inbox(f.first.id).deliveries.some((d) =>
          d.message_ids.includes(15) && d.outcome === "interrupted_unanswered"
        ),
      10000,
    );

    const summary =
      "## Objective\n- Qualify explicit chat tools.\n\n## Requirements\n- Use explicit tool sends.\n\n## Decisions\n- Never mirror terminal answers.\n\n## Work State\n### Completed\n- Explicit sends and interruption.\n### Active\n- Compaction and restart.\n### Blocked\n- None.\n\n## Next Move\n1. Receive another room message.\n\n## Relevant Files\n- None.\n\n## Important Context\n- Isolated native fixture.";
    provider.queue.push({ text: summary }, { text: summary });
    const compactID = nativeID("msg");
    await api(`/api/session/${session.id}/compact`, { id: compactID });
    await poll(
      async () =>
        (await messages(session.id)).some((m) =>
          m.id === compactID && m.status === "completed"
        ),
      30000,
    );
    await idle(session.id);
    // The v2 compactor needs one summary; reserve handling is based on observed
    // queue state, not a fake successful compaction assertion.
    while (provider.queue.length && provider.queue[0].text === summary) {
      provider.queue.shift();
    }
    provider.queue.push(
      tool("send_message", { chat_id: 42, text: "POST_COMPACT_REPLY" }),
      { text: "POST_COMPACT_TERMINAL" },
    );
    f.incoming(roomMessage(16));
    await poll(
      () => f.sent.some((s) => s.text === "POST_COMPACT_REPLY"),
      30000,
    );
    await idle(session.id);
    await stop();
    await start();
    provider.queue.push(
      tool("send_message", { chat_id: 42, text: "POST_RESTART_REPLY" }),
      { text: "POST_RESTART_TERMINAL" },
    );
    f.incoming(roomMessage(17));
    await poll(
      () => f.sent.some((s) => s.text === "POST_RESTART_REPLY"),
      30000,
    );
    await idle(session.id);
    provider.queue.push({
      tool: {
        name: "execute",
        args: {
          code:
            'await tools["chat"].send_message({chat_id:42,text:"SAME_PROGRAM_FIRST"}); return await tools["chat"].send_message({chat_id:42,text:"SAME_PROGRAM_SECOND"});',
        },
      },
    }, { text: "SAME_PROGRAM_TERMINAL" });
    await api(`/api/session/${session.id}/prompt`, {
      id: nativeID("msg"),
      text: "Exercise two explicit sends inside one Code Mode program.",
    });
    await poll(
      () =>
        f.sent.some((s) => s.text === "SAME_PROGRAM_FIRST") &&
        f.sent.some((s) => s.text === "SAME_PROGRAM_SECOND"),
      30000,
    );
    await idle(session.id);
    const denied = (await api("/api/session", {
      title: "Private denied-tool qualification",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      location: { directory: `${run}/project` },
      permissions: [{ action: "chat_*", resource: "*", effect: "deny" }],
    })).data;
    const beforeDeniedSend = f.sent.length;
    provider.queue.push(
      tool("send_message", { chat_id: 42, text: "DENIED_MUST_NOT_POST" }),
      { text: "DENIED_TERMINAL_ONLY" },
    );
    await api(`/api/session/${denied.id}/prompt`, {
      id: nativeID("msg"),
      text: "Exercise the private native denial rule.",
    });
    await poll(
      async () =>
        (await messages(denied.id)).some((m) =>
          m.content?.some((p) => p.text === "DENIED_TERMINAL_ONLY")
        ),
      30000,
    );
    await idle(denied.id);
    await Deno.writeTextFile(
      `${run}/denied-messages.json`,
      JSON.stringify(await messages(denied.id), null, 2),
      { mode: 0o600 },
    );
    assertEquals(f.sent.length, beforeDeniedSend);
    assertEquals(provider.unexpected, []);
    await Deno.writeTextFile(
      `${run}/result.json`,
      JSON.stringify({
        session: session.id,
        explicitReply: true,
        terminalNotMirrored: true,
        busyBatching: true,
        interrupted: true,
        postCompactionReply: true,
        postRestartReply: true,
        providerRequests: provider.requests.length,
      }),
      { mode: 0o600 },
    );
    console.log(`Native v2 evidence: ${run}`);
  } finally {
    held?.resolve();
    // Failure evidence comes from the documented native API, not a private DB.
    if (child && sessionID) {
      await Deno.writeTextFile(
        `${run}/messages.json`,
        JSON.stringify(await messages(sessionID), null, 2),
        { mode: 0o600 },
      );
      await Deno.writeTextFile(
        `${run}/routing.json`,
        JSON.stringify(f.routing.inbox(f.first.id), null, 2),
        { mode: 0o600 },
      );
    }
    await Deno.writeTextFile(
      `${run}/provider-facts.json`,
      JSON.stringify(
        { requests: provider.requests, unexpected: provider.unexpected },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await stop();
    await provider.close();
    await relayHTTP.shutdown();
    await f.close();
  }
});
