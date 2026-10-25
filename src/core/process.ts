// SPDX-License-Identifier: LGPL-3.0-only
import { StdioDeltaChat } from "@deltachat/jsonrpc-client";
import { getRPCServerPath } from "@deltachat/stdio-rpc-server";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { CoreClient, CoreEvent, CoreRpc } from "./client.ts";
import { CoreUnavailable } from "./client.ts";

export type CoreState = "ready" | "restarting" | "stopped";
interface Options {
  accountsDir: string;
  onEvent?: (accountId: number, event: CoreEvent) => void;
  onState?: (state: CoreState) => void;
  /** Metadata only: core stderr can contain credentials or message bodies. */
  onDiagnostic?: (
    kind: string,
    fields: Record<string, number | string>,
  ) => void;
}
interface Generation {
  child: ChildProcessWithoutNullStreams;
  rpc: StdioDeltaChat["rpc"];
  lost: AbortController;
  closed: Promise<void>;
}
const backoff = [1000, 2000, 5000, 10000, 30000];

function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal,
  ms?: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => finish(() => reject(new CoreUnavailable()));
    if (signal.aborted) {
      reject(new CoreUnavailable());
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    if (ms !== undefined) {
      timer = setTimeout(() => finish(() => reject(new CoreUnavailable())), ms);
    }
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** One owner of the npm-selected binary, its upstream stdio transport and event reader. */
export class CoreProcess implements CoreClient {
  #state: CoreState = "restarting";
  #generation?: Generation;
  #stopping = false;
  #started = false;
  #stop?: Promise<void>;
  #lifetime = new AbortController();
  #runTask?: Promise<void>;
  constructor(readonly options: Options) {}
  get state() {
    return this.#state;
  }
  get pid() {
    return this.#generation?.child.pid;
  }
  #stateChanged(state: CoreState) {
    this.#state = state;
    this.options.onState?.(state);
  }
  async start(): Promise<void> {
    if (this.#started || this.#stopping) {
      throw new Error("Core owner already started");
    }
    this.#started = true;
    await Deno.mkdir(this.options.accountsDir, {
      recursive: true,
      mode: 0o700,
    });
    const ready = Promise.withResolvers<void>();
    this.#runTask = this.#run(ready.resolve, ready.reject);
    await ready.promise;
  }
  use<T>(call: (rpc: CoreRpc) => Promise<T>): Promise<T> {
    const generation = this.#generation;
    if (this.#state !== "ready" || !generation || this.#stopping) {
      return Promise.reject(new CoreUnavailable());
    }
    return bounded(
      Promise.resolve().then(() => call(generation.rpc)),
      generation.lost.signal,
      120000,
    );
  }
  #spawn(): Generation {
    // startDeltaChat() installs a fatal unexpected-exit throw and hides the child.
    // Upstream desktop likewise resolves the npm binary and owns spawn separately.
    const child = spawn(getRPCServerPath({ disableEnvPath: true }), {
      env: { DC_ACCOUNTS_PATH: this.options.accountsDir, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lost = new AbortController();
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => {
        lost.abort();
        resolve();
      })
    );
    child.on("error", () => {
      this.options.onDiagnostic?.("core_process_error", {});
    });
    child.stdin.on("error", () => {/* Process close owns recovery. */});
    child.stderr.on(
      "data",
      (chunk: Uint8Array) =>
        this.options.onDiagnostic?.("core_stderr", { bytes: chunk.byteLength }),
    );
    const rpc = new StdioDeltaChat(child.stdin, child.stdout, false).rpc;
    return { child, rpc, lost, closed };
  }
  async #events(generation: Generation) {
    try {
      while (!generation.lost.signal.aborted && !this.#stopping) {
        const events = await bounded(
          generation.rpc.getNextEventBatch(),
          generation.lost.signal,
        );
        for (const { contextId, event } of events) {
          this.options.onEvent?.(contextId, event);
        }
      }
    } catch {
      // A failed event reader cannot leave a falsely-ready generation alive.
      if (!generation.lost.signal.aborted && !this.#stopping) {
        generation.child.kill("SIGTERM");
      }
    }
  }
  async #run(resolveReady: () => void, rejectReady: (error: unknown) => void) {
    let first = true, failures = 0;
    while (!this.#stopping) {
      let generation: Generation | undefined;
      let events: Promise<void> | undefined;
      let readyAt = 0;
      try {
        generation = this.#spawn();
        this.#generation = generation;
        await bounded(
          generation.rpc.getSystemInfo(),
          generation.lost.signal,
          10000,
        );
        events = this.#events(generation);
        await bounded(
          generation.rpc.startIoForAllAccounts(),
          generation.lost.signal,
          10000,
        );
        if (this.#stopping) break;
        this.#stateChanged("ready");
        readyAt = Date.now();
        resolveReady();
        first = false;
        await generation.closed;
      } catch (error) {
        if (first) {
          this.#stopping = true;
          rejectReady(error);
        }
        this.options.onDiagnostic?.("core_generation_failed", {});
      } finally {
        if (generation && !generation.lost.signal.aborted) {
          generation.child.kill("SIGTERM");
          await generation.closed;
        }
        await events;
        this.#generation = undefined;
      }
      if (this.#stopping) break;
      this.#stateChanged("restarting");
      if (readyAt && Date.now() - readyAt >= 60000) failures = 0;
      const delay = backoff[Math.min(failures++, backoff.length - 1)];
      this.options.onDiagnostic?.("core_restart", { delayMs: delay });
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.#lifetime.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        this.#lifetime.signal.addEventListener("abort", finish, { once: true });
        if (this.#lifetime.signal.aborted) finish();
      });
    }
    this.#stateChanged("stopped");
  }
  close(): Promise<void> {
    if (!this.#stop) this.#stop = this.#shutdown();
    return this.#stop;
  }
  async #shutdown() {
    this.#stopping = true;
    this.#lifetime.abort();
    const generation = this.#generation;
    let forced = false;
    if (generation && !generation.lost.signal.aborted) {
      const term = setTimeout(() => generation.child.kill("SIGTERM"), 10000);
      const kill = setTimeout(() => {
        forced = true;
        generation.child.kill("SIGKILL");
      }, 13000);
      try {
        try {
          await bounded(
            generation.rpc.stopIoForAllAccounts(),
            generation.lost.signal,
            8000,
          );
        } catch {
          /* A crashed or wedged core still needs owned-child cleanup. */
        }
        generation.child.stdin.end();
        await generation.closed;
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
      }
    }
    await this.#runTask;
    this.#stateChanged("stopped");
    if (forced) throw new Error("Core required forced shutdown");
  }
}
