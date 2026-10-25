// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { AccessState } from "../access.ts";
import type { AppControl } from "../app-control.ts";
export function AccessScreen(
  props: { state: AccessState; actions: AppControl["actions"] },
) {
  return (
    <main class="access-sheet">
      <aside class="relay-context">
        <div
          class="relay-path"
          aria-label="Phone connected through relay to agent"
        >
          <div class="relay-station">
            <i aria-hidden="true" />
            <span>Phone</span>
          </div>
          <i class="relay-line" aria-hidden="true" />
          <div class="relay-station relay-node">
            <i aria-hidden="true" />
            <span>Relay</span>
          </div>
          <i class="relay-line" aria-hidden="true" />
          <div class="relay-station">
            <i aria-hidden="true" />
            <span>Agent</span>
          </div>
        </div>
        <p>Your messages stay here.</p>
        <p class="quiet">The agent connects when you enable its MCP.</p>
      </aside>
      <section class="access-form">
        <h1>
          {props.state.session?.setupRequired
            ? "Set access"
            : "Open your relay"}
        </h1>
        <p class="quiet">
          {props.state.session?.setupRequired
            ? "Choose who can use this relay."
            : "Sign in to manage agent access."}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.actions.submit();
          }}
        >
          <Show when={props.state.session?.setupRequired}>
            <fieldset class="access-modes" disabled={props.state.busy}>
              <legend>Access level</legend>
              <For
                each={[{ id: "public", label: "Public" }, {
                  id: "password",
                  label: "Password",
                }, { id: "totp", label: "Password + code" }] as const}
              >
                {(mode) => (
                  <label>
                    <input
                      type="radio"
                      name="access-mode"
                      value={mode.id}
                      checked={props.state.mode === mode.id}
                      onChange={() => props.actions.mode(mode.id)}
                    />
                    {mode.label}
                  </label>
                )}
              </For>
            </fieldset>
          </Show>
          <Show
            when={props.state.session?.setupRequired &&
              props.state.mode === "public"}
            fallback={
              <>
                <label for="username">Username</label>
                <input
                  id="username"
                  name="username"
                  autocomplete="username"
                  required
                  value={props.state.username}
                  disabled={props.state.busy}
                  onInput={(e) =>
                    props.actions.field("username", e.currentTarget.value)}
                />
                <label for="password">Password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autocomplete={props.state.session?.setupRequired
                    ? "new-password"
                    : "current-password"}
                  required
                  value={props.state.password}
                  disabled={props.state.busy}
                  onInput={(e) =>
                    props.actions.field("password", e.currentTarget.value)}
                />
                <Show
                  when={props.state.session?.setupRequired &&
                    props.state.mode === "totp"}
                >
                  <button
                    type="button"
                    class="enroll-button"
                    data-action="enroll"
                    disabled={props.state.busy}
                    onClick={() => props.actions.enroll()}
                  >
                    {props.state.enrollment
                      ? "Replace enrollment"
                      : "Set up authenticator"}
                  </button>
                  <Show when={props.state.enrollment}>
                    {(enrollment) => (
                      <div class="enrollment">
                        <img
                          src={props.state.qrUrl}
                          width="176"
                          height="176"
                          alt="Scan this enrollment QR in your authenticator"
                        />
                        <p>Add this key manually if you cannot scan:</p>
                        <code data-enrollment-key>{enrollment().key}</code>
                        <p>Enter its first code to finish setup.</p>
                      </div>
                    )}
                  </Show>
                </Show>
                <Show
                  when={props.state.session?.setupRequired
                    ? props.state.mode === "totp"
                    : props.state.session?.mode === "totp"}
                >
                  <label for="code">Authenticator code</label>
                  <input
                    id="code"
                    name="code"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxlength="6"
                    required
                    value={props.state.code}
                    disabled={props.state.busy}
                    onInput={(e) =>
                      props.actions.field("code", e.currentTarget.value)}
                  />
                </Show>
              </>
            }
          >
            <p class="public-note">
              Anyone who can reach this relay on your LAN can use it. MCP
              clients will not need a key.
            </p>
          </Show>
          <Show when={props.state.error}>
            <p role="alert" class="error">{props.state.error}</p>
          </Show>
          <button
            type="submit"
            class="primary"
            data-action="access-submit"
            disabled={props.state.busy ||
              (props.state.session?.setupRequired &&
                props.state.mode === "totp" && !props.state.enrollment)}
          >
            {props.state.busy
              ? "Working…"
              : props.state.session?.setupRequired
              ? "Save access"
              : "Log in"}
          </button>
        </form>
      </section>
    </main>
  );
}
