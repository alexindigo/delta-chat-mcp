// SPDX-License-Identifier: LGPL-3.0-only
export type Change =
  | { type: "account" | "connectivity" | "contacts" | "chats" }
  | { type: "messages"; chatId: number; ids: readonly number[] };
type Listener = (change: Change) => void | Promise<void>;

/** Notifications are hints. Core history remains the source of truth. */
export class ChangeHub {
  #listeners = new Set<Listener>();
  constructor(readonly listenerFailed: () => void = () => {}) {}
  get listenerCount() {
    return this.#listeners.size;
  }
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  emit(change: Change) {
    const value = Object.freeze(
      change.type === "messages"
        ? { ...change, ids: Object.freeze([...change.ids]) }
        : { ...change },
    );
    const failed = () => {
      try {
        this.listenerFailed();
      } catch { /* Diagnostics cannot break delivery. */ }
    };
    for (const listener of [...this.#listeners]) {
      try {
        Promise.resolve(listener(value)).catch(failed);
      } catch {
        failed();
      }
    }
  }
}
