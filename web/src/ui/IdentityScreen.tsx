// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { RelayState } from "../relays.ts";
import type { MessagingState } from "../messaging.ts";
import type { AppControl } from "../app-control.ts";
import { InvitePanel } from "./InvitePanel.tsx";
import { NativeSelect } from "./NativeSelect.tsx";
export function IdentityScreen(
  props: {
    state: MessagingState;
    relays: RelayState;
    relayOptions: string[];
    actions: AppControl["actions"];
  },
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
              <label for="public-relay">Chatmail relay</label>
              <NativeSelect
                id="public-relay"
                value={props.relays.selected}
                onChange={(event) =>
                  props.actions.relaySelect(event.currentTarget.value)}
              >
                <For each={props.relayOptions}>
                  {(domain) => <option value={domain}>{domain}</option>}
                </For>
                <option value="custom">Custom / private relay…</option>
              </NativeSelect>
              <div class="relay-directory">
                <button
                  type="button"
                  class="text-button"
                  data-action="refresh-relays"
                  disabled={props.relays.busy}
                  onClick={() => props.actions.refreshRelays()}
                >
                  {props.relays.busy
                    ? "Refreshing list…"
                    : "Refresh public-relay list"}
                </button>
                <p class="quiet">
                  Publicly listed by{" "}
                  <a
                    href={props.relays.catalog.source}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Chatmail
                  </a>, included{" "}
                  {props.relays.catalog.retrieved}. Listing does not guarantee
                  registration or availability.
                </p>
                <p role="status">{props.relays.notice}</p>
              </div>
              <Show when={props.relays.selected === "custom"}>
                <label for="relay">
                  Custom relay domain or DCACCOUNT invitation
                </label>
                <input
                  id="relay"
                  required
                  placeholder="relay.example or DCACCOUNT:…"
                  value={props.relays.custom}
                  onInput={(event) =>
                    props.actions.relayCustom(event.currentTarget.value)}
                />
                <p class="quiet">
                  Use a relay domain or its full DCACCOUNT invitation. A failed
                  attempt retries the same identity.
                </p>
              </Show>
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
