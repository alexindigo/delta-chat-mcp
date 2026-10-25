// SPDX-License-Identifier: LGPL-3.0-only
export interface EventFeed {
  start(changed: () => void, state: (connected: boolean) => void): void;
  close(): void;
}
/** Sole EventSource owner; every hello/reconnect is a canonical full resync. */
export class BrowserEvents implements EventFeed {
  #source: EventSource | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = true;
  start(changed: () => void, state: (connected: boolean) => void) {
    this.close();
    this.#closed = false;
    let delay = 500;
    const connect = () => {
      if (this.#closed) return;
      const source = this.#source = new EventSource("/api/events");
      source.addEventListener("hello", () => {
        delay = 500;
        state(true);
        changed();
      });
      source.addEventListener("changed", changed);
      source.addEventListener("resync", changed);
      source.onerror = () => {
        source.close();
        if (this.#source === source) this.#source = null;
        if (this.#closed) return;
        state(false);
        changed();
        this.#timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
    };
    connect();
  }
  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#source?.close();
    this.#source = null;
  }
}
