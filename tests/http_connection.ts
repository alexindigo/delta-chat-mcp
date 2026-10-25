// SPDX-License-Identifier: LGPL-3.0-only
import { deadline } from "./support.ts";

/** A real TCP peer which retains an incomplete upload until the server closes it. */
export class HttpConnection {
  wire = "";
  ended = false;
  #released = false;
  readonly finished: Promise<void>;
  constructor(readonly conn: Deno.TcpConn) {
    this.finished = (async () => {
      const bytes = new Uint8Array(4096), decoder = new TextDecoder();
      try {
        for (;;) {
          const count = await conn.read(bytes);
          if (count === null) break;
          this.wire += decoder.decode(bytes.subarray(0, count));
        }
      } catch (error) {
        if (
          !(error instanceof Deno.errors.ConnectionReset) &&
          !(this.#released && (error instanceof Deno.errors.BadResource ||
            error instanceof Deno.errors.Interrupted))
        ) throw error;
      } finally {
        this.ended = true;
      }
    })();
  }
  async write(text: string) {
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length;) {
      const count = await this.conn.write(bytes.subarray(offset));
      if (!count) throw new Error("Socket write stalled");
      offset += count;
    }
  }
  async close() {
    this.#released = true;
    this.conn.close();
    await deadline(this.finished, 3000);
  }
}
