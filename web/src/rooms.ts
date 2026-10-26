// SPDX-License-Identifier: LGPL-3.0-only
import { ApiError } from "./api.ts";
import type { Contact } from "./messaging-types.ts";
import type { RoomOutcome } from "../../src/messaging/room-outcome.ts";

export interface RoomApi {
  contacts(): Promise<{ contacts: Contact[] }>;
  createRoom(name: string, contactIds: number[]): Promise<{ chatId: number }>;
  completeRoom(id: number, contactIds: number[]): Promise<{ chatId: number }>;
}
export interface RoomChoice extends Contact {
  unavailable: boolean;
  reason: string;
}
export interface RoomState {
  open: boolean;
  name: string;
  selected: number[];
  contacts: RoomChoice[];
  loading: boolean;
  pending: boolean;
  error: string;
  outcome: RoomOutcome | null;
}
export const initialRoom = (): RoomState => ({
  open: false,
  name: "",
  selected: [],
  contacts: [],
  loading: false,
  pending: false,
  error: "",
  outcome: null,
});
export class Rooms {
  state = initialRoom();
  #epoch = 0;
  #contactsRequest = 0;
  constructor(
    private api: RoomApi,
    private publish: (state: RoomState) => void,
    private navigate: (id: number) => void,
    private refresh: () => Promise<void>,
    private unauthorized: () => void,
  ) {}
  private patch(value: Partial<RoomState>) {
    this.state = { ...this.state, ...value };
    this.publish(this.state);
  }
  get dirty() {
    return !!this.state.name || !!this.state.selected.length ||
      this.state.pending || !!this.state.outcome;
  }
  open() {
    this.patch({ open: true });
    void this.load();
  }
  close() {
    this.patch({ open: false });
  }
  clear() {
    this.#epoch++;
    this.#contactsRequest++;
    this.state = initialRoom();
    this.publish(this.state);
  }
  name(value: string) {
    if (!this.state.pending && !this.state.outcome) {
      this.patch({ name: value, error: "" });
    }
  }
  toggle(id: number) {
    if (this.state.pending || this.state.outcome) return;
    const selected = this.state.selected.includes(id);
    const choice = this.state.contacts.find((contact) => contact.id === id);
    if (!selected && (!choice || choice.unavailable)) return;
    if (!selected && this.state.selected.length >= 100) {
      this.patch({ error: "Select up to 100 contacts for one room." });
      return;
    }
    this.patch({
      selected: selected
        ? this.state.selected.filter((v) => v !== id)
        : [...this.state.selected, id],
      error: "",
    });
  }
  async load() {
    const epoch = this.#epoch, request = ++this.#contactsRequest;
    this.patch({ loading: true });
    try {
      const { contacts } = await this.api.contacts();
      if (epoch !== this.#epoch || request !== this.#contactsRequest) return;
      const choices = contacts.map((contact) => ({
        ...contact,
        unavailable: contact.isBlocked || !contact.isKeyContact ||
          !contact.e2eeAvail,
        reason: contact.isBlocked
          ? "Blocked"
          : !contact.isKeyContact
          ? "Not a key contact"
          : !contact.e2eeAvail
          ? "Encryption unavailable"
          : "",
      }));
      // A selected contact disappearing is visible, never a silently reduced set.
      for (const old of this.state.contacts) {
        if (
          this.state.selected.includes(old.id) &&
          !choices.some((c) => c.id === old.id)
        ) {
          choices.push({
            ...old,
            unavailable: true,
            reason: "No longer available",
          });
        }
      }
      this.patch({ contacts: choices });
    } catch (error) {
      if (epoch === this.#epoch && request === this.#contactsRequest) {
        this.patch({ error: this.failure(error) });
      }
    } finally {
      if (epoch === this.#epoch && request === this.#contactsRequest) {
        this.patch({ loading: false });
      }
    }
  }
  private failure(error: unknown) {
    if (error instanceof ApiError && error.status === 401) this.unauthorized();
    return error instanceof Error
      ? error.message
      : "Room request failed. Your input is kept.";
  }
  async submit() {
    if (this.state.pending || this.state.outcome) return;
    if (!this.state.name.trim()) {
      this.patch({ error: "Enter a room name." });
      return;
    }
    await this.run();
  }
  async complete() {
    if (
      this.state.pending || this.state.outcome?.kind !== "incomplete" ||
      this.state.outcome.completionStopped
    ) return;
    await this.run(this.state.outcome.chatId);
  }
  private async run(chatId?: number) {
    const epoch = this.#epoch,
      name = this.state.name,
      selected = [...this.state.selected];
    this.patch({ pending: true, error: "" });
    try {
      const result = await (chatId === undefined
        ? this.api.createRoom(name, selected)
        : this.api.completeRoom(chatId, selected));
      if (epoch !== this.#epoch) {
        return;
      }
      this.clear();
      this.navigate(result.chatId);
      await this.refresh();
    } catch (error) {
      if (epoch !== this.#epoch) return;
      const room = error instanceof ApiError ? error.room : undefined;
      const message = this.failure(error);
      const definiteRejection = error instanceof ApiError &&
        [400, 401, 403, 503].includes(error.status);
      const outcome = room?.kind === "rejected"
        ? null
        : room ?? (chatId !== undefined
          ? {
            kind: "incomplete" as const,
            chatId,
            intendedContactIds: selected,
            missingContactIds: null,
            completionStopped: false,
            message:
              "Completion was not acknowledged. Retry adding contacts to this same room, or open it to inspect.",
          }
          : definiteRejection
          ? null
          : {
            kind: "uncertain" as const,
            message:
              "Creation was not acknowledged. A room may exist. Inspect Conversations before deliberately creating another room.",
          });
      this.patch({
        pending: false,
        outcome,
        error: outcome?.message ?? message,
      });
      if (outcome) await this.refresh();
    } finally {
      if (epoch === this.#epoch) this.patch({ pending: false });
    }
  }
  inspect() {
    if (this.state.outcome?.kind !== "incomplete") return;
    this.close();
    this.navigate(this.state.outcome.chatId);
  }
  createAnother() {
    if (this.state.pending || this.state.outcome?.kind !== "uncertain") return;
    // Explicit acknowledgement of possible duplication keeps the input for review.
    this.patch({
      outcome: null,
      error:
        "Possible duplication acknowledged. Review before creating another room.",
    });
  }
  discard() {
    if (!this.state.pending) this.clear();
  }
}
