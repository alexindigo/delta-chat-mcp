// SPDX-License-Identifier: LGPL-3.0-only
/** Ephemeral per-chat draft revisions, never persisted in browser storage. */
export class Drafts {
  #values = new Map<number, { text: string; revision: number }>();
  get(chat: number) {
    return this.#values.get(chat) ?? { text: "", revision: 0 };
  }
  set(chat: number, text: string) {
    this.#values.set(chat, { text, revision: this.get(chat).revision + 1 });
  }
  sent(chat: number, revision: number) {
    if (this.get(chat).revision === revision) this.set(chat, "");
  }
  get dirty() {
    return [...this.#values.values()].some((value) => !!value.text);
  }
  clear() {
    this.#values.clear();
  }
}
