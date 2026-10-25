// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { MessagingState } from "../messaging.ts";
import type { AppControl } from "../app-control.ts";
import { InvitePanel } from "./InvitePanel.tsx";
export function IdentityScreen(
  props: { state: MessagingState; actions: AppControl["actions"] },
) {
  return (
    <section class="identity-screen">
      <h1>Relay identity</h1>
      <Show
        when={props.state.account?.configured}
        fallback={
          <>
            <p>
              Create this relay's own Delta Chat identity. Your phone pairs with
              it as a contact.
            </p>
            <form
              class="identity-form"
              onSubmit={(event) => {
                event.preventDefault();
                props.actions.createIdentity();
              }}
            >
              <label for="display-name">Display name</label>
              <input
                id="display-name"
                required
                maxlength={120}
                value={props.state.displayName}
                onInput={(event) =>
                  props.actions.identityField(
                    "displayName",
                    event.currentTarget.value,
                  )}
              />
              <label for="relay">Chatmail relay</label>
              <input
                id="relay"
                required
                placeholder="relay.example or DCACCOUNT:…"
                value={props.state.relay}
                onInput={(event) =>
                  props.actions.identityField(
                    "relay",
                    event.currentTarget.value,
                  )}
              />
              <p class="quiet">
                Use a relay domain or its full DCACCOUNT invitation. A failed
                attempt retries the same identity.
              </p>
              <Show when={props.state.identityError}>
                <p class="error" role="alert">{props.state.identityError}</p>
              </Show>
              <button
                type="submit"
                data-action="create-identity"
                disabled={props.state.creating ||
                  props.state.account?.core === "restarting"}
              >
                {props.state.creating
                  ? "Creating identity…"
                  : props.state.identityError
                  ? "Retry identity setup"
                  : "Create identity"}
              </button>
            </form>
          </>
        }
      >
        <p>
          This identity stays online independently of your browser and MCP
          clients.
        </p>
        <dl class="identity-facts">
          <dt>Name</dt>
          <dd>{props.state.account?.displayName}</dd>
          <dt>Address</dt>
          <dd class="machine" data-identity-address>
            {props.state.account?.address ?? "Waiting for core…"}
          </dd>
          <dt>Connection</dt>
          <dd>{props.state.connection}</dd>
        </dl>
        <InvitePanel
          invite={props.state.invite}
          qrUrl={props.state.qrUrl}
          copy={props.actions.copyInvite}
        />
      </Show>
      <Show when={props.state.notice}>
        <p role="status">{props.state.notice}</p>
      </Show>
    </section>
  );
}
