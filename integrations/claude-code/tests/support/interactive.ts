// SPDX-License-Identifier: LGPL-3.0-only
import { cp } from "node:fs/promises";
import { assertEquals } from "@std/assert";
import { deadline, poll } from "../../../../tests/support.ts";
import { openSqlite, type Sqlite } from "../../../opencode/sqlite.ts";

/** The external controller supplies only native terminal keys. This guest-side
 * owner controls identity, lifecycle, private configuration and assertions. */
export class InteractiveClaude {
  readonly session = crypto.randomUUID();
  readonly channel = "plugin:delta-chat@inline";
  readonly prefix = "mcp__plugin_delta-chat_relay__chat_";
  #child?: Deno.ChildProcess;
  #generation = -1;
  #db?: Sqlite;
  #input = 0;
  private constructor(
    readonly root: string,
    readonly project: string,
    readonly runtime: string,
    readonly binary: string,
    readonly providerURL: string,
  ) {}
  static async create(
    root: string,
    providerURL: string,
    relay: { url: string; headers: Record<string, string> },
  ) {
    const project = Deno.env.get("CLAUDE_TEST_PROJECT"),
      approvalsPath = Deno.env.get("CLAUDE_TEST_APPROVALS"),
      runtime = Deno.env.get("CHANNEL_DENO_BIN"),
      binary = Deno.env.get("CLAUDE_CODE_BIN");
    if (!project || !approvalsPath || !runtime || !binary) {
      throw new Error("Explicit private native fixture profile required");
    }
    for (
      const directory of [
        "/home",
        "/config",
        "/bin",
        "/config/plugins",
        "/config/plugins/data",
        "/config/plugins/data/delta-chat-inline",
      ]
    ) await Deno.mkdir(`${root}${directory}`, { mode: 0o700 });
    const approvals = JSON.parse(await Deno.readTextFile(approvalsPath));
    assertEquals(approvals.customApiKeyResponses.approved, [
      "private-fixture-only",
    ]);
    assertEquals(approvals.projects[project].hasTrustDialogAccepted, true);
    await Deno.writeTextFile(
      `${root}/config/.claude.json`,
      JSON.stringify(approvals),
      { mode: 0o600 },
    );
    await Deno.symlink(runtime, `${root}/bin/deno`);
    await cp(new URL("../../", import.meta.url), `${root}/plugin`, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await Deno.writeTextFile(
      `${root}/config/plugins/data/delta-chat-inline/config.json`,
      JSON.stringify({
        stateFile: `${root}/claude-progress.sqlite`,
        relays: { chat: { ...relay, enabled: true } },
      }),
      { mode: 0o600 },
    );
    const tracePath = Deno.env.get("CLAUDE_TEST_TRACE");
    if (!tracePath) throw new Error("Private native trace helper required");
    const trace = {
      type: "command",
      command: runtime,
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        tracePath,
        `${root}/hooks.jsonl`,
      ],
      timeout: 15,
    };
    await Deno.writeTextFile(
      `${root}/settings.json`,
      JSON.stringify({
        hooks: Object.fromEntries(
          [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "Stop",
            "StopFailure",
            "SessionEnd",
            "PreCompact",
            "PostCompact",
          ].map((e) => [e, [{ hooks: [trace] }]]),
        ),
      }),
      { mode: 0o600 },
    );
    return new InteractiveClaude(root, project, runtime, binary, providerURL);
  }
  async phase(value: Record<string, unknown>) {
    await Deno.writeTextFile(
      `${this.root}/phase.json`,
      JSON.stringify({
        session: this.session,
        generation: this.#generation,
        expectedChannel: this.channel,
        ...value,
      }),
      { mode: 0o600 },
    );
  }
  get db() {
    if (!this.#db) throw new Error("Native progress not open");
    return this.#db;
  }
  async start(resume = false) {
    if (this.#child) throw new Error("Native process already owned");
    this.#generation++;
    await this.phase({ phase: "starting" });
    await poll(async () => {
      try {
        return JSON.parse(
          await Deno.readTextFile(`${this.root}/controller-generation.json`),
        ).generation === this.#generation;
      } catch {
        return false;
      }
    }, 10000);
    const debug = `${this.root}/native-${this.#generation}.debug`;
    this.#child = new Deno.Command("/bin/sh", {
      args: [
        "-c",
        'exec "$@" </dev/tty >/dev/tty 2>/dev/tty',
        "native-fixture",
        this.binary,
        ...(resume
          ? ["--resume", this.session]
          : ["--session-id", this.session]),
        "--model",
        "claude-haiku-5-5",
        "--plugin-dir",
        `${this.root}/plugin`,
        "--settings",
        `${this.root}/settings.json`,
        "--setting-sources",
        "",
        "--allowedTools",
        `${this.prefix}*`,
        "--permission-mode",
        "default",
        "--tools",
        "",
        "--dangerously-load-development-channels",
        this.channel,
        "--debug-file",
        debug,
      ],
      cwd: this.project,
      clearEnv: true,
      env: {
        PATH:
          `${this.root}/bin:/opt/claude-experiments/bin:/usr/local/bin:/usr/bin:/bin`,
        HOME: `${this.root}/home`,
        CLAUDE_CONFIG_DIR: `${this.root}/config`,
        TMPDIR: Deno.env.get("TMPDIR")!,
        DENO_DIR: Deno.env.get("DENO_DIR")!,
        ANTHROPIC_API_KEY: "sk-ant-api03-private-fixture-only",
        ANTHROPIC_BASE_URL: this.providerURL,
        DISABLE_AUTOUPDATER: "1",
        NO_COLOR: "1",
        TERM: "xterm-256color",
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    await this.phase({
      phase: "awaiting-registration",
      nativePID: this.#child.pid,
    });
    await poll(async () => {
      try {
        const text = await Deno.readTextFile(debug);
        if (text.includes("Channel notifications skipped")) {
          throw new Error("Native Channels registration rejected");
        }
        return text.includes(
          'MCP server "plugin:delta-chat:relay": Channel notifications registered',
        );
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return false;
        throw e;
      }
    }, 120000);
    this.#db ??= await openSqlite(`${this.root}/claude-progress.sqlite`, true);
  }
  async input(text: string) {
    const key = `input-${++this.#input}`;
    await this.phase({ phase: "send-input", inputKey: key, text });
  }
  async idle() {
    await poll(
      () =>
        this.db.get(
          "SELECT busy FROM channel_native WHERE session=? AND ended=0",
          this.session,
        )?.busy === 0,
      30000,
    );
  }
  async hooks(): Promise<Record<string, unknown>[]> {
    try {
      return (await Deno.readTextFile(`${this.root}/hooks.jsonl`)).trim().split(
        "\n",
      ).filter(Boolean).map((r) => JSON.parse(r));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }
  }
  async escape() {
    await this.phase({
      phase: "send-key",
      inputKey: `escape-${++this.#input}`,
      key: "Escape",
    });
  }
  async stop() {
    if (!this.#child) return;
    const owned = this.#child;
    this.#child = undefined;
    owned.kill("SIGTERM");
    await deadline(owned.status, 15000);
    if (this.#db) {
      await poll(() =>
        !this.db.get(
          "SELECT 1 FROM channel_owner WHERE namespace=?",
          `claude:${this.session}`,
        ), 10000);
    }
  }
  async close() {
    await this.stop();
    this.#db?.close();
  }
}
