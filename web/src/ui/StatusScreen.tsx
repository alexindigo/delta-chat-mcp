// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { MessagingState } from "../messaging.ts";
export function StatusScreen(
  props: { state: MessagingState; refresh: () => void },
) {
  return (
    <section class="status-screen">
      <h1>Relay status</h1>
      <p>
        The core keeps receiving messages when this browser and your agent are
        disconnected.
      </p>
      <dl class="identity-facts">
        <dt>Identity</dt>
        <dd>{props.state.account?.displayName ?? "Not configured"}</dd>
        <dt>Address</dt>
        <dd class="machine">{props.state.account?.address ?? "Unavailable"}</dd>
        <dt>Core</dt>
        <dd data-core-state>{props.state.account?.core ?? "Unknown"}</dd>
        <dt>Chatmail</dt>
        <dd data-connectivity>{props.state.connection}</dd>
        <dt>Connectivity value</dt>
        <dd>{props.state.account?.connectivity ?? "Unavailable"}</dd>
        <dt>Live updates</dt>
        <dd>
          {props.state.stream
            ? "Listening for changes"
            : "Disconnected; reconnecting"}
        </dd>
      </dl>
      <Show when={!props.state.account?.configured}>
        <p>
          <a href="/identity">Set up the relay identity</a>{" "}
          to connect to chatmail.
        </p>
      </Show>
      <button
        type="button"
        data-action="refresh-status"
        onClick={() => props.refresh()}
      >
        Refresh status
      </button>
    </section>
  );
}
