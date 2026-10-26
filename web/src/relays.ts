// SPDX-License-Identifier: LGPL-3.0-only
import bundled from "../../defaults/public-relays.json" with { type: "json" };
import type { RelayCatalog, RelayResult } from "../../src/messaging/relays.ts";
export interface RelayApi {
  relays(): Promise<RelayCatalog>;
  refreshRelays(): Promise<RelayResult>;
}
export interface RelayState {
  catalog: RelayCatalog;
  selected: string;
  custom: string;
  busy: boolean;
  notice: string;
}
export const initialRelays = (): RelayState => ({
  catalog: structuredClone(bundled),
  selected: "nine.testrun.org",
  custom: "",
  busy: false,
  notice: "",
});
export class Relays {
  state = initialRelays();
  #epoch = 0;
  constructor(
    private api: RelayApi,
    private publish: (value: RelayState) => void,
  ) {}
  private patch(value: Partial<RelayState>) {
    this.state = { ...this.state, ...value };
    this.publish(this.state);
  }
  get value() {
    return this.state.selected === "custom"
      ? this.state.custom
      : this.state.selected;
  }
  get dirty() {
    return !!this.state.custom || this.state.selected !== "nine.testrun.org";
  }
  // Keep a removed-but-selected public entry available without inventing a homepage.
  get options() {
    return [
      ...new Set([
        ...this.state.catalog.relays.map((r) => r.domain),
        ...(this.state.selected !== "custom" ? [this.state.selected] : []),
      ]),
    ];
  }
  select(selected: string) {
    this.patch({ selected });
  }
  custom(value: string) {
    this.patch({ custom: value });
  }
  clear() {
    this.#epoch++;
    this.state = initialRelays();
    this.publish(this.state);
  }
  async load(refresh = false) {
    if (this.state.busy) return;
    const epoch = this.#epoch;
    this.patch({ busy: true, notice: "" });
    try {
      const catalog = refresh
        ? await this.api.refreshRelays()
        : await this.api.relays();
      if (epoch === this.#epoch) {
        this.patch({
          catalog,
          notice: "notice" in catalog && typeof catalog.notice === "string"
            ? catalog.notice
            : "",
        });
      }
    } catch {
      if (epoch === this.#epoch) {
        this.patch({
          notice:
            "Could not refresh the directory. The included list is still available.",
        });
      }
    } finally {
      if (epoch === this.#epoch) this.patch({ busy: false });
    }
  }
}
