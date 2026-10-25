// SPDX-License-Identifier: LGPL-3.0-only
import type { AuthState } from "../auth/state.ts";
import type { ChangeHub } from "../events.ts";

type Hint = { type: string; chatId?: number };
/** Bounded change hints, never message contents, IDs or another history. */
export class EventStreams {
  readonly bootId = crypto.randomUUID();
  #clients = new Set<{ cookie: string; close: () => void }>();
  #closed = false;
  constructor(
    private readonly events: ChangeHub,
    private readonly auth: Pick<AuthState, "authenticated">,
    private readonly heartbeatMs = 15000,
  ) {}
  get size() {
    return this.#clients.size;
  }
  logout(request: Request) {
    const cookie = request.headers.get("cookie") ?? "";
    for (const client of [...this.#clients]) {
      if (client.cookie === cookie) client.close();
    }
  }
  close() {
    this.#closed = true;
    for (const client of [...this.#clients]) client.close();
  }
  response(request: Request): Response {
    if (this.#closed) return new Response(null, { status: 503 });
    if (this.size >= 32) return new Response(null, { status: 429 });
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let ended = false,
      hello = true,
      resync = false,
      heartbeat = false,
      checking = false;
    let off = () => {};
    let timer: ReturnType<typeof setInterval>;
    const pending = new Map<string, Hint>();
    const encoder = new TextEncoder();
    const finish = (closeStream: boolean) => {
      if (ended) return;
      ended = true;
      off();
      clearInterval(timer);
      pending.clear();
      request.signal.removeEventListener("abort", client.close);
      this.#clients.delete(client);
      if (closeStream) controller.close();
    };
    const client = {
      cookie: request.headers.get("cookie") ?? "",
      close: () => finish(true),
    };
    const pump = () => {
      if (ended || (controller.desiredSize ?? 0) <= 0) return;
      let frame: string;
      if (hello) {
        hello = false;
        frame = `event: hello\ndata: ${
          JSON.stringify({ bootId: this.bootId })
        }\n\n`;
      } else if (resync) {
        resync = false;
        frame = "event: resync\ndata: {}\n\n";
      } else if (pending.size) {
        const hints = [...pending.values()];
        pending.clear();
        frame = `event: changed\ndata: ${JSON.stringify({ hints })}\n\n`;
      } else if (heartbeat) {
        heartbeat = false;
        frame = ": heartbeat\n\n";
      } else return;
      controller.enqueue(encoder.encode(frame));
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value;
        this.#clients.add(client);
        off = this.events.subscribe((change) => {
          if (ended || resync) return;
          const hint: Hint = change.type === "messages"
            ? { type: change.type, chatId: change.chatId }
            : { type: change.type };
          pending.set(`${hint.type}:${hint.chatId ?? ""}`, hint);
          if (pending.size > 32) {
            pending.clear();
            resync = true;
          }
          pump();
        });
        timer = setInterval(async () => {
          if (ended || checking) return;
          checking = true;
          try {
            if (!await this.auth.authenticated(request)) {
              client.close();
              return;
            }
            heartbeat = true;
            pump();
          } catch {
            client.close();
          } finally {
            checking = false;
          }
        }, this.heartbeatMs);
        request.signal.addEventListener("abort", client.close, { once: true });
        if (request.signal.aborted) client.close();
        else pump();
      },
      pull: () => pump(),
      cancel: () => finish(false),
    }, { highWaterMark: 1 });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }
}
