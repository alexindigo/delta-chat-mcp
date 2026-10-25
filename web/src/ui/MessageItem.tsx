// SPDX-License-Identifier: LGPL-3.0-only
import { onCleanup, Show } from "solid-js";
import type { Message } from "../messaging-types.ts";
export function MessageItem(
  props: {
    message: Message;
    sender: string;
    time: string;
    selected: boolean;
    toggle: () => void;
    observe: (element: Element, id: number) => () => void;
  },
) {
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  return (
    <article
      class={`message-item ${
        props.message.fromSelf ? "message-self" : "message-peer"
      }`}
      data-message-id={props.message.id}
      data-message-state={props.message.state}
      ref={(element) => {
        stop = props.observe(element, props.message.id);
      }}
    >
      <label class="message-selection">
        <input
          type="checkbox"
          checked={props.selected}
          onChange={() => props.toggle()}
        />
        <span class="visually-hidden">Select message from {props.sender}</span>
      </label>
      <div class="message-content">
        <div class="message-meta">
          <strong>{props.sender}</strong>
          <time>{props.time}</time>
        </div>
        <p class="message-text">{props.message.text}</p>
        <Show when={props.message.hasAttachment}>
          <p class="message-attachment">
            Attachment: {props.message.attachmentName ?? "Unnamed attachment"}
          </p>
        </Show>
        <p class="message-state">
          {props.message.encrypted ? "Encrypted" : "Encryption not indicated"}
          <Show when={props.message.fromSelf}>· {props.message.state}</Show>
        </p>
      </div>
    </article>
  );
}
