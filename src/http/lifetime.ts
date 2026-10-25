// SPDX-License-Identifier: LGPL-3.0-only

/** Own admission, handler work, response delivery and native connections together. */
export function serveHttp(
  listen: { hostname: string; port: number },
  handler: (request: Request) => Response | Promise<Response>,
) {
  const cancellation = new AbortController();
  const pending = new Set<Promise<void>>();
  let closing = false, finished = false, shutdown: Promise<void> | undefined;
  const server = Deno.serve(
    { ...listen, signal: cancellation.signal, onListen() {} },
    (request, info) => {
      if (closing) {
        return Response.json({ error: "Service unavailable" }, { status: 503 });
      }
      const response = Promise.resolve().then(() => handler(request));
      // Handler return is not transport completion (uploads/streamed responses
      // can still be pending). Observe both; native serve owns request errors.
      const settled = Promise.allSettled([response, info.completed]).then(
        () => {},
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return response;
    },
  );
  const nativeFinished = server.finished.finally(() => {
    finished = true;
  });
  return {
    addr: server.addr,
    finished: nativeFinished,
    close(): Promise<void> {
      closing = true;
      if (!shutdown) {
        shutdown = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // Allow accepted application work and response bodies to finish.
            // Do NOT call native shutdown(): Deno2.9.6 consumes the server RID
            // there, making a later signal unable to cancel held connections.
            // Keep the full connection drain window even if handlers and
            // info.completed settle sooner: native response completion can
            // precede the final socket write. Cancelling in that microtask
            // loses an otherwise completed response on the selected runtime.
            await new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
            });
          } finally {
            clearTimeout(timer);
            if (!finished) cancellation.abort();
          }
          await nativeFinished;
          // Aborting native I/O releases body reads and response streams. Join
          // handlers too, before composition closes their durable dependencies.
          await Promise.all([...pending]);
        })();
      }
      return shutdown;
    },
  };
}
