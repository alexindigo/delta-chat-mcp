// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { serveHttp } from "../../src/http/lifetime.ts";
import { HttpConnection } from "../http_connection.ts";
import { deadline, lanAddress, poll } from "../support.ts";

Deno.test("HTTP lifetime joins cancelled body consumers and response streams, but drains completed work", async () => {
  for (const mode of ["json", "text", "stream", "complete"] as const) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let handlerFinished = false, bodyCancelled = false;
    const http = serveHttp(
      { hostname: lanAddress(), port: 0 },
      async (request) => {
        if (new URL(request.url).pathname === "/later") {
          return new Response("must not run");
        }
        entered.resolve();
        try {
          if (mode === "json" || mode === "text") {
            try {
              await request[mode]();
            } catch {
              bodyCancelled = true;
            }
            return new Response("cancelled");
          }
          if (mode === "stream") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("first"));
                },
                cancel() {
                  bodyCancelled = true;
                },
              }),
            );
          }
          await release.promise;
          return new Response("committed response");
        } finally {
          handlerFinished = true;
        }
      },
    );
    const peer = new HttpConnection(
      await Deno.connect({ hostname: lanAddress(), port: http.addr.port }),
    );
    try {
      const body = mode === "json" || mode === "text";
      await peer.write(
        body
          ? "POST / HTTP/1.1\r\nHost: fixture\r\nContent-Length: 53\r\nConnection: close\r\n\r\n{"
          : "GET / HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n",
      );
      await deadline(entered.promise);
      const start = performance.now();
      const closed = http.close();
      assertEquals(http.close(), closed);
      // Admission closes synchronously, before the bounded drain interval.
      const rejected = await fetch(
        `http://${lanAddress()}:${http.addr.port}/later`,
      );
      assertEquals(rejected.status, 503);
      await rejected.body?.cancel();
      if (mode === "complete") release.resolve();
      await deadline(closed, 3000);
      await deadline(peer.finished, 1000);
      console.log({ mode, wire: peer.wire, handlerFinished, bodyCancelled });
      assert(handlerFinished);
      assert(peer.ended);
      if (mode === "complete") assert(peer.wire.includes("committed response"));
      else assert(bodyCancelled);
      assert(performance.now() - start < 3000);
    } finally {
      release.resolve();
      await peer.close();
      await deadline(http.close());
    }
    await poll(() => handlerFinished);
  }
});
