// SPDX-License-Identifier: LGPL-3.0-only
import { For, onCleanup, Show } from "solid-js";
import type { MessagingState } from "../messaging.ts";
import type { AppControl } from "../app-control.ts";
import { messageTime, sender } from "../presentation.ts";
import { MessageItem } from "./MessageItem.tsx";
import { NewRoom } from "./NewRoom.tsx";
function History(
  props: { state: MessagingState; actions: AppControl["actions"] },
) {
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  return (
    <div
      class="message-history"
      aria-label="Conversation history"
      ref={(element) => {
        stop = props.actions.bindHistory(element);
      }}
    >
      <Show when={props.state.hasEarlier && props.state.messages.length}>
        <button
          class="earlier-button"
          type="button"
          data-action="earlier"
          disabled={props.state.historyBusy}
          onClick={() => props.actions.earlier()}
        >
          {props.state.historyBusy ? "Loading earlier…" : "Load earlier"}
        </button>
      </Show>
      <Show
        when={props.state.messages.length}
        fallback={
          <p class="quiet">
            {props.state.historyBusy
              ? "Loading conversation…"
              : "No messages yet. Write the first message below."}
          </p>
        }
      >
        {/* Canonical refetches replace DTOs, not native media/selection lifetimes. */}
        <For each={props.state.messages} keyed={(message) => message.id}>
          {(message) => (
            <MessageItem
              message={message()}
              sender={sender(message(), props.state.contacts)}
              time={messageTime(message().timestamp)}
              selected={props.state.selected.includes(message().id)}
              toggle={() => props.actions.toggleMessage(message().id)}
              observe={props.actions.observeMessage}
              image={props.state.attachments[message().id]}
              imageEvent={(src, failed) =>
                props.actions.imageEvent(message().id, src, failed)}
              retryImage={() => props.actions.retryImage(message().id)}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
export function ChatScreen(
  props: {
    state: MessagingState;
    roomDisabled: boolean;
    actions: AppControl["actions"];
  },
) {
  return (
    <section class={`chats-screen ${props.state.chatId ? "has-chat" : ""}`}>
      <div class="chats-heading">
        <h1>Chats</h1>
        <Show when={props.state.account?.configured}>
          <div class="narrow-room-entry">
            <NewRoom
              disabled={props.roomDisabled}
              open={props.actions.newRoom}
            />
          </div>
        </Show>
      </div>
      <Show
        when={props.state.account?.configured}
        fallback={
          <p>
            Create the relay identity first.{" "}
            <a href="/identity">Set up identity</a>
          </p>
        }
      >
        <div class={`chat-desk ${props.state.chatId ? "chat-selected" : ""}`}>
          <aside class="chat-index">
            <header class="chat-index-header">
              <div class="conversation-actions">
                <h2>Conversations</h2>
                <NewRoom
                  disabled={props.roomDisabled}
                  open={props.actions.newRoom}
                />
              </div>
            </header>
            <div class="chat-items">
              <Show
                when={props.state.chats.length}
                fallback={
                  <p class="quiet">
                    No chats yet. <a href="/contacts">Pair a contact</a>{" "}
                    to start.
                  </p>
                }
              >
                <For each={props.state.chats}>
                  {(chat) => (
                    <a
                      class="chat-entry"
                      href={`/chats/${chat.id}`}
                      data-chat-id={chat.id}
                      aria-current={props.state.chatId === chat.id
                        ? "page"
                        : undefined}
                    >
                      <span class="chat-entry-title">
                        <strong>{chat.name}</strong>
                        <Show when={chat.freshMessageCount}>
                          <span class="fresh-count">
                            {chat.freshMessageCount} new
                          </span>
                        </Show>
                      </span>
                      <span class="chat-preview">
                        {chat.summary || "No messages yet"}
                      </span>
                      <Show when={chat.lastMessageTime}>
                        <time class="chat-time">
                          {messageTime(chat.lastMessageTime!)}
                        </time>
                      </Show>
                      <Show when={chat.isContactRequest}>
                        <span class="quiet">Contact request</span>
                      </Show>
                    </a>
                  )}
                </For>
              </Show>
            </div>
          </aside>
          <section class="conversation" aria-label="Selected conversation">
            <header class="conversation-header">
              <a class="chat-back" href="/chats">Back to chats</a>
              <h2>
                {props.state.chat?.name ?? (props.state.chatId
                  ? "Loading conversation…"
                  : "Choose a conversation")}
              </h2>
              <Show when={props.state.chat}>
                <p class="quiet">
                  {props.state.chat?.isEncrypted
                    ? "Encrypted chat"
                    : "Encryption not indicated"} ·{" "}
                  {props.state.chat?.contactIds.length}{" "}
                  {props.state.chat?.contactIds.length === 1
                    ? "contact"
                    : "contacts"}
                </p>
              </Show>
            </header>
            <Show
              when={props.state.chatId}
              fallback={
                <div class="conversation-empty">
                  <p>Your phone and agent share the same history here.</p>
                  <a href="/contacts">Pair a contact</a>
                </div>
              }
            >
              <History state={props.state} actions={props.actions} />
              <div class="composer-row">
                <Show
                  when={props.state.chat?.type === "Group" &&
                    props.state.chat.isUnpromoted}
                >
                  <p class="quiet" data-room-first-message>
                    The first message distributes this room to its contacts.
                    Creating it has not delivered it to peers.
                  </p>
                </Show>
                <Show when={props.state.chat?.isContactRequest}>
                  <p>
                    This is a contact request.{" "}
                    <a href="/contacts">Accept or block in Contacts</a>.
                  </p>
                </Show>
                <Show when={props.state.selected.length}>
                  <div class="message-delete">
                    <span>
                      {props.state.selected.length}{" "}
                      selected. Delete from this identity only.
                    </span>
                    <Show
                      when={props.state.confirmDelete}
                      fallback={
                        <button
                          type="button"
                          data-action="ask-delete-messages"
                          onClick={() =>
                            props.actions.confirmMessageDelete(true)}
                        >
                          Delete selected
                        </button>
                      }
                    >
                      <button
                        type="button"
                        data-action="delete-messages"
                        onClick={() => props.actions.deleteMessages()}
                      >
                        Delete locally
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          props.actions.confirmMessageDelete(false)}
                      >
                        Cancel
                      </button>
                    </Show>
                  </div>
                </Show>
                <form
                  class="message-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    props.actions.send();
                  }}
                >
                  <label for="message-draft">Message</label>
                  <textarea
                    id="message-draft"
                    rows={3}
                    value={props.state.draft}
                    onInput={(event) =>
                      props.actions.draft(event.currentTarget.value)}
                    onKeyDown={(event) => props.actions.composerKey(event)}
                    placeholder="Write a message"
                  />
                  <div class="composer-actions">
                    <span class="quiet">
                      Enter sends · Shift+Enter adds a line
                    </span>
                    <button
                      type="submit"
                      class="primary"
                      data-action="send-message"
                      disabled={props.state.sending ||
                        !props.state.draft.trim() ||
                        !props.state.chat?.canSend ||
                        props.state.account?.core !== "ready"}
                    >
                      {props.state.sending ? "Sending…" : "Send message"}
                    </button>
                  </div>
                </form>
                <Show when={props.state.sendError}>
                  <p role="alert" class="error">
                    {props.state.sendError}{" "}
                    Your draft is kept. Retry with Send message.
                  </p>
                </Show>
              </div>
            </Show>
          </section>
        </div>
      </Show>
    </section>
  );
}
