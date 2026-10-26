// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { AttachmentPresentation } from "../attachments.ts";

/** Render data and forward native load/error/retry intents only. */
export function MessageAttachment(props: {
  image: AttachmentPresentation | undefined;
  event: (src: string, failed: boolean) => void;
  retry: () => void;
}) {
  return (
    <div class="message-media">
      <Show when={props.image?.src}>
        <img
          src={props.image?.src}
          alt={props.image?.alt ?? "Received image"}
          width={props.image?.width}
          height={props.image?.height}
          onLoad={(event) =>
            props.event(event.currentTarget.getAttribute("src")!, false)}
          onError={(event) =>
            props.event(event.currentTarget.getAttribute("src")!, true)}
        />
      </Show>
      <Show when={props.image?.status}>
        <p class="message-media-status" role="status">{props.image?.status}</p>
      </Show>
      <Show when={props.image?.retry}>
        <button type="button" class="image-retry" onClick={() => props.retry()}>
          Retry image
        </button>
      </Show>
    </div>
  );
}
