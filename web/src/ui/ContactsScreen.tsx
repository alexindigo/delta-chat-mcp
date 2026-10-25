// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { MessagingState } from "../messaging.ts";
import type { AppControl } from "../app-control.ts";
import { InvitePanel } from "./InvitePanel.tsx";
export function ContactsScreen(
  props: { state: MessagingState; actions: AppControl["actions"] },
) {
  return (
    <section class="contacts-screen">
      <h1>Contacts</h1>
      <Show
        when={props.state.account?.configured}
        fallback={
          <p>
            Create the relay identity first.{" "}
            <a href="/identity">Set up identity</a>
          </p>
        }
      >
        <InvitePanel
          invite={props.state.invite}
          qrUrl={props.state.qrUrl}
          copy={props.actions.copyInvite}
        />
        <section class="contact-join">
          <h2>Join a contact</h2>
          <p>
            Paste their Delta Chat invitation. An email address alone is not a
            pairing invitation.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              props.actions.joinContact();
            }}
          >
            <label for="contact-invite">Contact invitation</label>
            <textarea
              id="contact-invite"
              required
              rows={3}
              value={props.state.link}
              onInput={(event) =>
                props.actions.invitation(event.currentTarget.value)}
            />
            <button
              type="submit"
              data-action="join-contact"
              disabled={props.state.contactBusy}
            >
              {props.state.contactBusy ? "Working…" : "Join contact"}
            </button>
          </form>
        </section>
        <Show when={props.state.contactError}>
          <p class="error" role="alert">{props.state.contactError}</p>
        </Show>
        <Show when={props.state.notice}>
          <p role="status">{props.state.notice}</p>
        </Show>
        <section class="contact-requests">
          <h2>Contact requests</h2>
          <Show
            when={props.state.chats.some((chat) => chat.isContactRequest)}
            fallback={<p class="quiet">No pending requests.</p>}
          >
            <For
              each={props.state.chats.filter((chat) => chat.isContactRequest)}
            >
              {(chat) => (
                <div class="request-row" data-request-id={chat.id}>
                  <div>
                    <strong>{chat.name}</strong>
                    <p>{chat.summary}</p>
                  </div>
                  <div class="request-actions">
                    <button
                      type="button"
                      disabled={props.state.contactBusy}
                      data-action="accept-request"
                      onClick={() =>
                        props.actions.requestContact(chat.id, "accept")}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      disabled={props.state.contactBusy}
                      data-action="block-request"
                      onClick={() =>
                        props.actions.requestContact(chat.id, "block")}
                    >
                      Block
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </section>
        <section class="contact-list">
          <h2>Your contacts</h2>
          <Show
            when={props.state.contacts.length}
            fallback={
              <p class="quiet">
                No contacts yet. Share your invitation or join a contact above.
              </p>
            }
          >
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name / address</th>
                    <th>Key contact</th>
                    <th>Encryption available</th>
                    <th>Chat</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={props.state.contacts}>
                    {(contact) => (
                      <tr data-contact-id={contact.id}>
                        <td>
                          <strong>{contact.displayName}</strong>
                          <div class="machine contact-address">
                            {contact.address ||
                              "Key contact without email address"}
                          </div>
                        </td>
                        <td>{contact.isKeyContact ? "Yes" : "No"}</td>
                        <td>{contact.e2eeAvail ? "Yes" : "Not yet"}</td>
                        <td>
                          <button
                            type="button"
                            disabled={props.state.contactBusy ||
                              contact.isBlocked}
                            onClick={() =>
                              props.actions.openContact(contact.id)}
                          >
                            Chat
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>
      </Show>
    </section>
  );
}
