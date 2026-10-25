// SPDX-License-Identifier: LGPL-3.0-only
import { type Api, ApiError, type KeyRow, type NewKey } from "./api.ts";
export interface KeyView extends KeyRow {
  createdText: string;
  lastUsedText: string;
}
const present = (row: KeyRow): KeyView => ({
  ...row,
  createdText: new Date(row.created).toLocaleDateString(),
  lastUsedText: row.lastUsed === null
    ? "Never"
    : new Date(row.lastUsed).toLocaleString(),
});
export interface KeysState {
  rows: KeyView[];
  name: string;
  shown: NewKey | null;
  confirm: string | null;
  busy: boolean;
  error: string;
  notice: string;
}
export const initialKeys = (): KeysState => ({
  rows: [],
  name: "",
  shown: null,
  confirm: null,
  busy: false,
  error: "",
  notice: "",
});
export class Keys {
  state = initialKeys();
  #generation = 0;
  constructor(
    private api: Api,
    private clipboard: (text: string) => Promise<void>,
    private publish: (state: KeysState) => void,
    private unauthorized: () => void,
  ) {}
  private patch(patch: Partial<KeysState>) {
    this.state = { ...this.state, ...patch };
    this.publish(this.state);
  }
  clear() {
    this.#generation++;
    this.state = initialKeys();
    this.publish(this.state);
  }
  name(value: string) {
    this.patch({ name: value });
  }
  dismiss() {
    this.patch({ shown: null, notice: "" });
  }
  confirm(id: string | null) {
    this.patch({ confirm: id });
  }
  private async run(action: (generation: number) => Promise<void>) {
    if (this.state.busy) return;
    const generation = this.#generation;
    this.patch({ busy: true, error: "", notice: "" });
    try {
      await action(generation);
    } catch (error) {
      if (generation === this.#generation) {
        this.patch({
          error: error instanceof Error
            ? error.message
            : "Key request failed. Try again.",
        });
        if (error instanceof ApiError && error.status === 401) {
          this.unauthorized();
        }
      }
    } finally {
      if (generation === this.#generation) this.patch({ busy: false });
    }
  }
  load() {
    return this.run(async (generation) => {
      const { keys } = await this.api.keys();
      if (generation === this.#generation) {
        this.patch({ rows: keys.map(present) });
      }
    });
  }
  create() {
    if (this.state.shown) return Promise.resolve();
    return this.run(async (generation) => {
      const shown = await this.api.createKey(this.state.name);
      if (generation !== this.#generation) return;
      this.patch({
        shown,
        name: "",
        rows: [
          ...this.state.rows,
          present({
            id: shown.id,
            name: shown.name,
            created: shown.created,
            lastUsed: null,
          }),
        ],
      });
    });
  }
  remove() {
    const id = this.state.confirm;
    if (!id) return Promise.resolve();
    return this.run(async (generation) => {
      await this.api.deleteKey(id);
      if (generation === this.#generation) {
        this.patch({
          rows: this.state.rows.filter((row) => row.id !== id),
          shown: this.state.shown?.id === id ? null : this.state.shown,
          confirm: null,
          notice: "Key deleted. Its MCP sessions are closed.",
        });
      }
    });
  }
  copy(text: string) {
    return this.run(async (generation) => {
      await this.clipboard(text);
      if (generation === this.#generation) this.patch({ notice: "Copied." });
    });
  }
}
