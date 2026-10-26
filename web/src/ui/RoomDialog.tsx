// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { RoomState } from "../rooms.ts";
import type { AppControl } from "../app-control.ts";
import { Dialog } from "./Dialog.tsx";

export function RoomDialog(
  props: { state: RoomState; actions: AppControl["actions"] },
) {
  return (
    <Dialog
      class="room-dialog"
      labelledBy="room-title"
      describedBy="room-help"
      cancel={props.actions.closeRoom}
    >
      <h2 id="room-title">New room</h2>
      <p id="room-help" class="quiet">
        Create an encrypted Group. Its first message distributes the room to
        selected contacts; creating it does not send an invitation.
      </p>
      <form
        class="room-form"
        onSubmit={(event) => {
          event.preventDefault();
          props.actions.createRoom();
        }}
      >
        <label for="room-name">Room name</label>
        <input
          id="room-name"
          autofocus
          value={props.state.name}
          disabled={props.state.pending || !!props.state.outcome}
          onInput={(event) => props.actions.roomName(event.currentTarget.value)}
        />
        <fieldset
          class="room-members"
          disabled={props.state.pending || !!props.state.outcome}
        >
          <legend>Contacts</legend>
          <p class="quiet" role="status" data-room-count>
            {props.state.selected.length
              ? `${props.state.selected.length} selected`
              : "Only this identity"}
          </p>
          <Show when={props.state.loading}>
            <p role="status">Refreshing contacts…</p>
          </Show>
          <Show
            when={props.state.contacts.length}
            fallback={
              <p class="quiet">
                No contacts available. You can create a room for only this
                identity, or pair contacts first.
              </p>
            }
          >
            <For each={props.state.contacts} keyed={(contact) => contact.id}>
              {(contact) => (
                <label class="room-contact" data-room-contact={contact().id}>
                  <input
                    type="checkbox"
                    checked={props.state.selected.includes(contact().id)}
                    disabled={contact().unavailable &&
                      !props.state.selected.includes(contact().id)}
                    onChange={() =>
                      props.actions.roomToggle(contact().id)}
                  />
                  <span class="room-contact-text">
                    <strong>
                      {contact().displayName || contact().address}
                    </strong>
                    <span>{contact().address}</span>
                    <Show when={contact().reason}>
                      <span>{contact().reason}</span>
                    </Show>
                  </span>
                </label>
              )}
            </For>
          </Show>
        </fieldset>
        <Show when={props.state.error}>
          <p class="error" role="alert">{props.state.error}</p>
        </Show>
        <Show when={props.state.outcome?.kind === "incomplete"}>
          <p class="quiet" data-room-recovery>
            Room ID: {props.state.outcome?.kind === "incomplete"
              ? props.state.outcome.chatId
              : ""}. The actual room is kept.
          </p>
          <div class="actions">
            <button
              type="button"
              data-action="complete-room"
              disabled={props.state.pending ||
                (props.state.outcome?.kind === "incomplete" &&
                  props.state.outcome.completionStopped)}
              onClick={props.actions.completeRoom}
            >
              Retry adding contacts
            </button>
            <button
              type="button"
              data-action="open-incomplete-room"
              onClick={props.actions.inspectRoom}
            >
              Open room
            </button>
          </div>
        </Show>
        <Show when={props.state.outcome?.kind === "uncertain"}>
          <div class="actions">
            <button
              type="button"
              data-action="inspect-conversations"
              onClick={props.actions.inspectConversations}
            >
              Inspect Conversations
            </button>
            <button
              type="button"
              data-action="another-room"
              onClick={props.actions.anotherRoom}
            >
              Create another room (may duplicate)
            </button>
          </div>
        </Show>
        <div class="actions room-actions">
          <button
            type="submit"
            class="primary"
            data-action="create-room"
            disabled={props.state.pending || !!props.state.outcome}
          >
            {props.state.pending ? "Setting up room…" : "Create room"}
          </button>
          <button
            type="button"
            data-action="close-room"
            onClick={props.actions.closeRoom}
          >
            Close (draft kept)
          </button>
          <button
            type="button"
            data-action="discard-room"
            disabled={props.state.pending}
            onClick={props.actions.discardRoom}
          >
            {props.state.outcome
              ? "Dismiss setup (room kept)"
              : "Discard draft"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
