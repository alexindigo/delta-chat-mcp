// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { deadline } from "../../../tests/support.ts";
import { routingFixture } from "../../../tests/room_routing_support.ts";
import { openSqlite } from "../../opencode/sqlite.ts";
import { ClaudeProvider } from "./support/provider.ts";

Deno.test("Claude 2.1.316: native hook/worker identity, explicit tool send and clean stdio teardown", async () => {
  const binary = Deno.env.get("CLAUDE_CODE_BIN"),
    runtime = Deno.env.get("CHANNEL_DENO_BIN"),
    tmp = Deno.env.get("TMPDIR");
  if (!binary || !runtime || !tmp || tmp === "/tmp") {
    throw new Error(
      "Explicit native/runtime binaries and disk TMPDIR required",
    );
  }
  const run = await Deno.makeTempDir({ dir: tmp, prefix: "claude-explicit-" });
  for (const name of ["home", "config", "project"]) {
    await Deno.mkdir(`${run}/${name}`, { mode: 0o700 });
  }
  const f = await routingFixture(), provider = new ClaudeProvider();
  const relayHTTP = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, (request) => f.fetcher(request));
  const config = {
    stateFile: `${run}/progress.sqlite`,
    relays: {
      chat: {
        url: `http://127.0.0.1:${relayHTTP.addr.port}/mcp`,
        enabled: true,
        headers: { Authorization: `Bearer ${f.first.key}` },
      },
    },
  };
  await Deno.writeTextFile(`${run}/channel.json`, JSON.stringify(config), {
    mode: 0o600,
  });
  const hook = {
    type: "command",
    command: runtime,
    args: [
      "run",
      "--allow-all",
      new URL("../hook.js", import.meta.url).pathname,
      `${run}/channel.json`,
    ],
    timeout: 15,
  };
  await Deno.writeTextFile(
    `${run}/settings.json`,
    JSON.stringify({
      hooks: Object.fromEntries(
        [
          "SessionStart",
          "UserPromptSubmit",
          "PreToolUse",
          "Stop",
          "StopFailure",
          "SessionEnd",
        ].map((event) => [event, [{ hooks: [hook] }]]),
      ),
    }),
    { mode: 0o600 },
  );
  await Deno.writeTextFile(
    `${run}/mcp.json`,
    JSON.stringify({
      mcpServers: {
        "delta-chat": {
          command: runtime,
          args: [
            "run",
            "--allow-all",
            new URL("../worker.js", import.meta.url).pathname,
            `${run}/channel.json`,
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  const session = crypto.randomUUID();
  const text = `EXPLICIT_CLAUDE_REPLY_${session}`;
  provider.queue.push({
    tool: {
      name: "mcp__delta-chat__chat_send_message",
      input: { chat_id: 42, text },
    },
  }, { text: "CLAUDE_TERMINAL_ONLY" });
  let child: Deno.ChildProcess | undefined;
  try {
    child = new Deno.Command(binary, {
      args: [
        "--print",
        "Use the private MCP send_message tool once with the scripted reply. Then finish in the terminal.",
        "--session-id",
        session,
        "--model",
        "claude-haiku-5-5",
        "--mcp-config",
        `${run}/mcp.json`,
        "--strict-mcp-config",
        "--settings",
        `${run}/settings.json`,
        "--setting-sources",
        "",
        "--allowedTools",
        "mcp__delta-chat__chat_send_message",
        "--permission-mode",
        "default",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "3",
      ],
      cwd: `${run}/project`,
      clearEnv: true,
      env: {
        PATH: "/opt/claude-experiments/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: `${run}/home`,
        CLAUDE_CONFIG_DIR: `${run}/config`,
        TMPDIR: tmp,
        ANTHROPIC_API_KEY: "sk-ant-api03-private-fixture-only",
        ANTHROPIC_BASE_URL: provider.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        NO_COLOR: "1",
        DENO_DIR: Deno.env.get("DENO_DIR")!,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const owned = child;
    const output = await deadline(owned.output(), 60000);
    child = undefined;
    await Deno.writeFile(`${run}/stdout.jsonl`, output.stdout, { mode: 0o600 });
    await Deno.writeFile(`${run}/stderr.log`, output.stderr, { mode: 0o600 });
    assertEquals(output.code, 0);
    assertEquals(f.sent.filter((s) => s.text === text).length, 1);
    assert(!f.sent.some((s) => s.text === "CLAUDE_TERMINAL_ONLY"));
    const db = await openSqlite(config.stateFile, true);
    try {
      const binding = db.get(
        "SELECT * FROM channel_native WHERE session=?",
        session,
      );
      assert(binding && binding.ended === 1);
      assertEquals(db.all("SELECT * FROM channel_owner"), []);
      assertEquals(
        db.all("SELECT core_id FROM channel_send WHERE state='sent'").length,
        1,
      );
    } finally {
      db.close();
    }
    assertEquals(provider.unexpected, []);
    console.log(`Ordinary native Claude evidence: ${run}`);
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await deadline(child.status, 10000);
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
    await provider.close();
    await relayHTTP.shutdown();
    await f.close();
  }
});
