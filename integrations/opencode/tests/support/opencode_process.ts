// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { deadline, poll } from "../../../../tests/support.ts";
import type { ProviderFixture } from "./provider_fixture.ts";
import type { McpFixture } from "./mcp_fixture.ts";

export interface ProbeRow {
  time: number;
  kind: string;
  directory: string;
  epoch: string;
  [key: string]: unknown;
}
export interface NativeMessage {
  info: {
    id: string;
    role: string;
    parentID?: string;
    agent?: string;
    model?: Record<string, unknown>;
    time: { created: number; completed?: number };
    finish?: string;
    error?: { name: string };
  };
  parts: {
    id: string;
    type: string;
    text?: string;
    synthetic?: boolean;
    metadata?: Record<string, unknown>;
    tool?: string;
    state?: { status: string; output?: string; error?: string };
  }[];
}

/** Owns only this test's unprivileged server process, private config and logs. */
export class OpenCodeProcess {
  readonly root: string;
  readonly directory: string;
  readonly otherDirectory: string;
  readonly probeLog: string;
  readonly #password = crypto.randomUUID();
  #httpClient?: Deno.HttpClient;
  readonly #environment: Record<string, string>;
  readonly #binary: string;
  readonly #config: string;
  readonly #port: number;
  #hostname = "127.0.0.1";
  #child?: Deno.ChildProcess;
  #io: Promise<unknown>[] = [];
  #launch = 0;
  #settings: Record<string, unknown>;

  private constructor(
    root: string,
    provider: ProviderFixture,
    mcp: McpFixture,
    delayUrl: string,
  ) {
    this.root = root;
    this.directory = `${root}/project-a`;
    this.otherDirectory = `${root}/project-b`;
    this.probeLog = `${root}/probe.jsonl`;
    this.#binary = Deno.env.get("OPENCODE_BIN") ?? "";
    assert(
      this.#binary.startsWith(
        "/home/dev/delta-chat-mcp-automatic-room-wake/tools/opencode-",
      ),
    );
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    this.#port = listener.addr.port;
    listener.close();
    this.#config = `${root}/opencode.json`;
    this.#settings = {
      ...provider.config(),
      plugin: [
        new URL("../fixtures/probe-plugin.ts", import.meta.url).href,
        new URL("../fixtures/delay-plugin.ts", import.meta.url).href,
      ],
      agent: {
        selected: { mode: "primary", description: "J0 selected primary" },
      },
      mcp: {
        fixture: {
          type: "remote",
          url: "{env:DCMCP_TEST_MCP_URL}",
          oauth: false,
          headers: { Authorization: "Bearer {env:DCMCP_TEST_MCP_TOKEN}" },
          enabled: true,
        },
      },
    };
    const tmp = Deno.env.get("TMPDIR")!;
    assert(tmp === "/home/dev/delta-chat-mcp-automatic-room-wake/.tmp");
    this.#environment = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/xdg/config`,
      XDG_DATA_HOME: `${root}/xdg/data`,
      XDG_CACHE_HOME: `${root}/xdg/cache`,
      XDG_STATE_HOME: `${root}/xdg/state`,
      TMPDIR: tmp,
      DENO_DIR: Deno.env.get("DENO_DIR")!,
      OPENCODE_CONFIG: this.#config,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      OPENCODE_SERVER_PASSWORD: this.#password,
      DCMCP_PROBE_LOG: this.probeLog,
      DCMCP_TEST_MCP_URL: mcp.url,
      DCMCP_TEST_MCP_TOKEN: mcp.token,
      DCMCP_DELAY_URL: delayUrl,
    };
  }

  static async create(
    provider: ProviderFixture,
    mcp: McpFixture,
    delayUrl: string,
  ) {
    const base = fromFileUrl(
      new URL("../../../../.test-state/opencode/", import.meta.url),
    );
    await Deno.mkdir(base, { recursive: true, mode: 0o700 });
    const root = await Deno.makeTempDir({ dir: base, prefix: "contracts-" });
    const process = new OpenCodeProcess(root, provider, mcp, delayUrl);
    for (
      const dir of [process.directory, process.otherDirectory, `${root}/home`]
    ) {
      await Deno.mkdir(dir, { mode: 0o700 });
    }
    await Deno.writeTextFile(
      process.#config,
      JSON.stringify(process.#settings),
      { mode: 0o600 },
    );
    return process;
  }

  get url() {
    return `http://127.0.0.1:${this.#port}`;
  }
  get serverUrl() {
    return `http://${this.#hostname}:${this.#port}/`;
  }
  get binary() {
    return this.#binary;
  }

  async version() {
    const output = await deadline(new Deno.Command(this.#binary, {
      args: ["--version"],
      cwd: this.root,
      clearEnv: true,
      env: this.#environment,
      stdout: "piped",
      stderr: "piped",
    }).output());
    assertEquals(output.code, 0);
    return new TextDecoder().decode(output.stdout).trim();
  }

  async start(hostname = this.#hostname, extra: Record<string, string> = {}) {
    assert(
      !this.#child,
      "Must prove original process exited before another launch",
    );
    this.#hostname = hostname;
    this.#launch++;
    const stdout = await Deno.open(
      `${this.root}/server-${this.#launch}.stdout.log`,
      { createNew: true, write: true, mode: 0o600 },
    );
    const stderr = await Deno.open(
      `${this.root}/server-${this.#launch}.stderr.log`,
      { createNew: true, write: true, mode: 0o600 },
    );
    this.#child = new Deno.Command(this.#binary, {
      args: [
        "serve",
        "--hostname",
        hostname,
        "--port",
        String(this.#port),
        "--print-logs",
        "--log-level",
        "WARN",
      ],
      cwd: this.directory,
      clearEnv: true,
      env: { ...this.#environment, ...extra },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#io = [
      this.#child.stdout.pipeTo(stdout.writable),
      this.#child.stderr.pipeTo(stderr.writable),
    ];
    // Captured stdout can be buffered until exit, so use an independently
    // observed health200 barrier, then still require the native Deno request.
    await poll(async () => {
      const curl = new Deno.Command("/usr/bin/curl", {
        args: [
          "--config",
          "-",
          "--silent",
          "--max-time",
          "2",
          "--output",
          `${this.root}/health-${this.#launch}.body`,
          "--write-out",
          "%{http_code}",
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = curl.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(
          `url = "${this.url}/global/health"\nuser = "opencode:${this.#password}"\n`,
        ),
      );
      await writer.close();
      const result = await curl.output();
      return result.code === 0 &&
        new TextDecoder().decode(result.stdout) === "200";
    }, 30_000);
    // Scope the connection pool to the server process generation, not the fixture.
    this.#httpClient = Deno.createHttpClient({ http2: false });
    // Readiness boundary observation: statuses/error names only, never credentials.
    const observed = new Set<string>();
    try {
      await poll(async () => {
        try {
          const response = await this.raw(
            "/global/health",
            "GET",
            undefined,
            undefined,
            true,
          );
          observed.add(`HTTP ${response.status}`);
          const ok = response.ok;
          await response.body?.cancel();
          return ok;
        } catch (error) {
          observed.add(error instanceof Error ? error.name : "unknown error");
          return false;
        }
      }, 30_000);
    } catch (error) {
      const curl = new Deno.Command("/usr/bin/curl", {
        args: [
          "--config",
          "-",
          "--silent",
          "--max-time",
          "5",
          "--output",
          `${this.root}/readiness-${this.#launch}.body`,
          "--write-out",
          "%{http_code}",
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = curl.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(
          `url = "${this.url}/global/health"\nuser = "opencode:${this.#password}"\n`,
        ),
      );
      await writer.close();
      const result = await curl.output();
      observed.add(
        `curl exit ${result.code} HTTP ${
          new TextDecoder().decode(result.stdout)
        }`,
      );
      const client = Deno.createHttpClient({ http2: false });
      try {
        // Project uses DOM RequestInit; Deno's documented client extension is structural.
        const options: RequestInit & { client: Deno.HttpClient } = {
          client,
          headers: {
            Authorization: `Basic ${btoa(`opencode:${this.#password}`)}`,
          },
          signal: AbortSignal.timeout(5_000),
        };
        const response = await fetch(`${this.url}/global/health`, options);
        observed.add(`Deno HTTP1 ${response.status}`);
        await response.body?.cancel();
      } catch (diagnosticError) {
        observed.add(
          `Deno HTTP1 ${
            diagnosticError instanceof Error
              ? diagnosticError.name
              : "unknown error"
          }`,
        );
      } finally {
        client.close();
      }
      throw error;
    } finally {
      const facts = { url: this.url, observed: [...observed] };
      await Deno.writeTextFile(
        `${this.root}/readiness-${this.#launch}.json`,
        JSON.stringify(facts),
      );
      console.log(JSON.stringify({ readiness: facts }));
    }
  }

  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    if (!this.#child) return;
    this.#child.kill(signal);
    await deadline(this.#child.status, 10_000);
    await deadline(Promise.all(this.#io), 5_000);
    this.#child = undefined;
    this.#httpClient?.close();
    this.#httpClient = undefined;
  }

  async close() {
    await this.stop();
  }

  async configure(updates: Record<string, unknown>) {
    this.#settings = { ...this.#settings, ...updates };
    await Deno.writeTextFile(this.#config, JSON.stringify(this.#settings), {
      mode: 0o600,
    });
  }

  async raw(
    path: string,
    method = "GET",
    body?: unknown,
    directory?: string,
    auth = true,
  ) {
    assert(
      this.#httpClient,
      "No client outside the running process generation",
    );
    const url = new URL(path, this.url);
    if (directory) url.searchParams.set("directory", directory);
    const options: RequestInit & { client: Deno.HttpClient } = {
      client: this.#httpClient,
      method,
      headers: {
        ...(auth
          ? { Authorization: `Basic ${btoa(`opencode:${this.#password}`)}` }
          : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    };
    return await fetch(url, options);
  }

  async api<T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
    directory = this.directory,
  ): Promise<T> {
    const response = await this.raw(path, method, body, directory);
    if (!response.ok) {
      const error = await response.text();
      await Deno.writeTextFile(
        `${this.root}/api-error-${crypto.randomUUID()}.txt`,
        error,
        { mode: 0o600 },
      );
      throw new Error(
        `OpenCode ${method} ${path} returned ${response.status}; private error saved`,
      );
    }
    return response.status === 204 ? undefined as T : await response.json();
  }

  async session(title: string, directory = this.directory) {
    return await this.api<{ id: string }>("/session", "POST", {
      title: `J0 ${title}`,
    }, directory);
  }

  async prompt(
    session: string,
    body: Record<string, unknown>,
    directory = this.directory,
  ) {
    const response = await this.raw(
      `/session/${session}/prompt_async`,
      "POST",
      body,
      directory,
    );
    assertEquals(response.status, 204);
    await response.body?.cancel();
  }

  messages(session: string, directory = this.directory) {
    return this.api<NativeMessage[]>(
      `/session/${session}/message`,
      "GET",
      undefined,
      directory,
    );
  }

  async found(session: string, message: string) {
    const response = await this.raw(
      `/session/${session}/message/${message}`,
      "GET",
      undefined,
      this.directory,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    assertEquals(response.status, 200);
    return await response.json() as NativeMessage;
  }

  async final(session: string, parent?: string, directory = this.directory) {
    let final: NativeMessage | undefined;
    await poll(async () => {
      const rows = await this.messages(session, directory);
      final = rows.findLast((m) =>
        m.info.role === "assistant" &&
        (!parent || m.info.parentID === parent) &&
        !!m.info.finish && m.info.finish !== "tool-calls" &&
        m.info.finish !== "unknown"
      );
      if (!final) return false;
      const status = await this.api<Record<string, { type: string }>>(
        "/session/status",
        "GET",
        undefined,
        directory,
      );
      return !status[session] || status[session].type === "idle";
    }, 30_000);
    return final!;
  }

  async rows() {
    try {
      return (await Deno.readTextFile(this.probeLog)).trim().split("\n").filter(
        Boolean,
      ).map((line) => JSON.parse(line) as ProbeRow);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }

  async waitRow(predicate: (row: ProbeRow) => boolean) {
    let row: ProbeRow | undefined;
    await poll(async () => {
      row = (await this.rows()).findLast(predicate);
      return !!row;
    }, 15_000);
    return row!;
  }

  async events() {
    assert(this.#httpClient);
    const abort = new AbortController();
    const options: RequestInit & { client: Deno.HttpClient } = {
      client: this.#httpClient,
      headers: { Authorization: `Basic ${btoa(`opencode:${this.#password}`)}` },
      signal: abort.signal,
    };
    const response = await fetch(`${this.url}/global/event`, options);
    assertEquals(response.status, 200);
    const rows: {
      directory?: string;
      payload?: { type: string; properties?: Record<string, unknown> };
    }[] = [];
    const reader = response.body!.getReader();
    const task = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          pending += decoder.decode(part.value, { stream: true });
          let end;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) {
                rows.push(JSON.parse(line.slice(6)));
              }
            }
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        reader.releaseLock();
      }
    })();
    let closing: Promise<void> | undefined;
    return {
      rows,
      close() {
        return closing ??= (async () => {
          // Own the body reader: aborting fetch alone is not a bounded join.
          const cancelled = reader.cancel();
          abort.abort();
          await deadline(Promise.all([cancelled, task]), 5_000);
        })();
      },
    };
  }
}

export class DelayControl {
  readonly held = new Map<string, { resolve: (status: number) => void }[]>();
  readonly url: string;
  readonly #http: Deno.HttpServer<Deno.NetAddr>;
  #nextWake?: "hold" | "error";
  #nextToast = false;

  constructor() {
    this.#http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const pathname = new URL(request.url).pathname;
        const wake = pathname.startsWith("/wake/");
        const toast = pathname.startsWith("/toast/");
        if (toast) {
          if (!this.#nextToast) return new Response(null, { status: 204 });
          this.#nextToast = false;
        }
        if (wake) {
          const mode = this.#nextWake;
          this.#nextWake = undefined;
          if (!mode) return new Response(null, { status: 204 });
          if (mode === "error") return new Response(null, { status: 409 });
        }
        const id = pathname.slice(
          (wake ? "/wake/" : toast ? "/toast/" : "/hold/").length,
        );
        const latch = Promise.withResolvers<number>();
        this.held.set(id, [...(this.held.get(id) ?? []), latch]);
        const status = await latch.promise;
        return new Response(null, { status });
      },
    );
    this.url = `http://127.0.0.1:${this.#http.addr.port}`;
  }

  release(id: string, status = 200) {
    for (const hold of this.held.get(id) ?? []) hold.resolve(status);
    this.held.delete(id);
  }
  armNextWake(mode: "hold" | "error") {
    if (this.#nextWake) throw new Error("Wake control already armed");
    this.#nextWake = mode;
  }
  armNextToast() {
    if (this.#nextToast) throw new Error("Toast control already armed");
    this.#nextToast = true;
  }

  async close() {
    for (const id of this.held.keys()) this.release(id, 409);
    await this.#http.shutdown();
  }
}
