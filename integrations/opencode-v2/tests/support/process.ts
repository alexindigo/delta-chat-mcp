// SPDX-License-Identifier: LGPL-3.0-only
import { deadline, poll } from "../../../../tests/support.ts";
import { nativeID } from "../../../opencode/registry.ts";
import type { ProviderFixture } from "../../../opencode/tests/support/provider_fixture.ts";

export interface NativeMessage {
  id: string;
  type: string;
  text?: string;
  metadata?: { deltachat?: { delivery: string } };
  content?: {
    text?: string;
    type: string;
    state?: { metadata?: { toolCalls?: { status: string }[] } };
  }[];
}
export class V2Process {
  #child?: Deno.ChildProcess;
  #logs: Promise<unknown>[] = [];
  #launch = 0;
  readonly #password = crypto.randomUUID();
  private constructor(
    readonly root: string,
    readonly provider: ProviderFixture,
    readonly port: number,
    readonly binary: string,
  ) {}
  static async create(
    root: string,
    provider: ProviderFixture,
    relay: { url: string; headers: Record<string, string> },
  ) {
    const binary = Deno.env.get("OPENCODE_V2_BIN"),
      tmp = Deno.env.get("TMPDIR");
    if (!binary || !tmp || tmp === "/tmp") {
      throw new Error("Explicit guest profile required");
    }
    for (
      const directory of [
        "",
        "/home",
        "/config",
        "/config/opencode",
        "/data",
        "/state",
        "/cache",
        "/project",
      ]
    ) await Deno.mkdir(`${root}${directory}`, { mode: 0o700 });
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = listener.addr.port;
    listener.close();
    const instance = new V2Process(root, provider, port, binary);
    await Deno.writeTextFile(
      `${root}/config/opencode/opencode.json`,
      JSON.stringify({
        update: "disable",
        share: "disabled",
        snapshots: false,
        model: "test/test-model",
        formatter: false,
        lsp: false,
        provider: provider.config().provider,
        plugins: [{
          package: new URL("../../", import.meta.url).href,
          options: {
            stateFile: `${root}/progress.sqlite`,
            relays: { chat: { ...relay, enabled: true } },
          },
        }],
      }),
      { mode: 0o600 },
    );
    return instance;
  }
  async api(path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Basic ${btoa(`opencode:${this.#password}`)}`,
        "content-type": "application/json",
        "x-opencode-directory": `${this.root}/project`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Private native API ${path} HTTP${response.status}`);
    }
    return text ? JSON.parse(text) : undefined;
  }
  async start() {
    if (this.#child) throw new Error("Native process already owned");
    const n = this.#launch++;
    const stdout = await Deno.open(`${this.root}/native-${n}.stdout`, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    const stderr = await Deno.open(`${this.root}/native-${n}.stderr`, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    this.#child = new Deno.Command(this.binary, {
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)],
      cwd: `${this.root}/project`,
      clearEnv: true,
      env: {
        PATH: "/opt/claude-experiments/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: `${this.root}/home`,
        XDG_CONFIG_HOME: `${this.root}/config`,
        XDG_DATA_HOME: `${this.root}/data`,
        XDG_STATE_HOME: `${this.root}/state`,
        XDG_CACHE_HOME: `${this.root}/cache`,
        TMPDIR: Deno.env.get("TMPDIR")!,
        OPENCODE_PASSWORD: this.#password,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#logs = [
      this.#child.stdout.pipeTo(stdout.writable),
      this.#child.stderr.pipeTo(stderr.writable),
    ];
    await poll(async () => {
      try {
        return (await this.api("/api/info")).version === "2.2.5";
      } catch {
        return false;
      }
    }, 30000);
    await this.api("/api/agent");
  }
  async session() {
    return (await this.api("/api/session", {
      title: "Cross-client room qualification",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      location: { directory: `${this.root}/project` },
      permissions: [{ action: "chat_*", resource: "*", effect: "allow" }],
    })).data.id as string;
  }
  messages(session: string): Promise<NativeMessage[]> {
    return this.api(`/api/session/${session}/message?limit=100&order=asc`).then(
      (v) => v.data,
    );
  }
  async idle(session: string) {
    await poll(
      async () => !(await this.api("/api/session/active")).data[session],
      30000,
    );
  }
  queueTool(name: string, args: unknown, terminal: string) {
    this.provider.queue.push({
      tool: {
        name: "execute",
        args: {
          code: `return await tools.chat.${name}(${JSON.stringify(args)});`,
        },
      },
    }, { text: terminal });
  }
  async tool(session: string, name: string, args: unknown) {
    const terminal = `CONTROL_${crypto.randomUUID()}`;
    this.queueTool(name, args, terminal);
    await this.api(`/api/session/${session}/prompt`, {
      id: nativeID("msg"),
      text: "Run the scripted private control tool.",
    });
    await poll(
      async () =>
        (await this.messages(session)).some((m) =>
          m.content?.some((p) => p.text === terminal)
        ),
      30000,
    );
    await this.idle(session);
  }
  async stop() {
    if (!this.#child) return;
    const owned = this.#child;
    this.#child = undefined;
    owned.kill("SIGTERM");
    await deadline(Promise.all([owned.status, ...this.#logs]), 15000);
  }
}
