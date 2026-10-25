// SPDX-License-Identifier: LGPL-3.0-only
// Raw CDP following OTK tests/support/cdp.ts and Kosmozoo tests/e2e/cdp.cjs.
import { deadline, poll } from "./support.ts";

type Json = Record<string, unknown>;

export class Cdp {
  #socket?: WebSocket;
  #nextId = 0;
  #pending = new Map<number, {
    resolve: (result: Json) => void;
    reject: (error: Error) => void;
  }>();
  #exited = false;
  #exit: Promise<Deno.CommandStatus>;
  #closing?: Promise<void>;
  errors: unknown[] = [];

  private constructor(
    private child: Deno.ChildProcess,
    private logs: Promise<void>,
  ) {
    this.#exit = child.status.then((status) => {
      this.#exited = true;
      return status;
    });
  }

  static async launch(profile: string, address: string, evidence: string) {
    const log = await Deno.open(`${evidence}/chromium.log`, {
      create: true,
      write: true,
    });
    const child = new Deno.Command("chromium", {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-breakpad",
        "--window-size=800,600",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        `--host-resolver-rules=MAP delta-chat-mcp.test ${address}`,
        "--no-proxy-server",
        "about:blank",
      ],
      env: { TMPDIR: Deno.env.get("TMPDIR")! },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const cdp = new Cdp(child, child.stderr.pipeTo(log.writable));
    console.log(`owned Chromium pid=${child.pid}; profile=${profile}`);
    try {
      let port = 0;
      await poll(async () => {
        try {
          const active = await Deno.readTextFile(
            `${profile}/DevToolsActivePort`,
          );
          port = Number(active.split("\n")[0]);
          return port > 0;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return false;
          throw error;
        }
      }, 10_000);
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      });
      const targets: { type: string; webSocketDebuggerUrl: string }[] =
        await response.json();
      const page = targets.find((target) => target.type === "page");
      if (!page) throw new Error("Chromium has no page target");
      const socket = cdp.#socket = new WebSocket(page.webSocketDebuggerUrl);
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.method === "Runtime.exceptionThrown") {
          cdp.errors.push(message.params.exceptionDetails);
        }
        if (
          message.method === "Runtime.consoleAPICalled" &&
          message.params.type === "error"
        ) cdp.errors.push(message.params);
        const pending = cdp.#pending.get(message.id);
        if (pending) {
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        }
      };
      await deadline(
        new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () => reject(new Error("CDP open failed"));
          socket.onclose = () => reject(new Error("CDP closed during open"));
        }),
        5_000,
      );
      socket.onclose = () => cdp.#rejectPending(new Error("CDP closed"));
      socket.onerror = () => cdp.#rejectPending(new Error("CDP failed"));
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      return cdp;
    } catch (error) {
      await cdp.close();
      throw error;
    }
  }

  #rejectPending(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async send(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.#nextId;
    try {
      return await deadline(
        new Promise<Json>((resolve, reject) => {
          this.#pending.set(id, { resolve, reject });
          this.#socket!.send(JSON.stringify({ id, method, params }));
        }),
        10_000,
      );
    } finally {
      this.#pending.delete(id);
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return (result.result as { value: T }).value;
  }

  async screenshot(path: string) {
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    const data = result.data as string;
    await Deno.writeFile(
      path,
      Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
    );
  }

  async close(): Promise<void> {
    await (this.#closing ??= (async () => {
      const socket = this.#socket;
      const socketClosed = socket && socket.readyState !== WebSocket.CLOSED
        ? new Promise<void>((resolve) =>
          socket.addEventListener("close", () => resolve(), { once: true })
        )
        : Promise.resolve();
      try {
        if (!this.#exited) {
          if (socket?.readyState === WebSocket.OPEN) {
            await this.send("Browser.close").catch((error) => {
              // Browser.close is allowed to close the socket before its reply.
              if (error.message !== "CDP closed") throw error;
            });
          } else this.child.kill("SIGTERM");
        }
        const status = await deadline(this.#exit, 5_000);
        if (!status.success) throw new Error(`Chromium exited ${status.code}`);
      } finally {
        if (!this.#exited) {
          this.child.kill("SIGKILL");
          await deadline(this.#exit, 5_000);
        }
        this.#rejectPending(new Error("CDP closed"));
        socket?.close();
        await deadline(socketClosed, 5_000);
        await this.logs;
      }
    })());
  }
}
