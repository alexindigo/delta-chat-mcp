// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { KeysState } from "../keys.ts";
import type { AppControl } from "../app-control.ts";
export function KeysScreen(
  props: {
    state: KeysState;
    publicMode: boolean;
    config: string;
    actions: AppControl["actions"];
  },
) {
  return (
    <section class="keys-screen">
      <h1>Agent access</h1>
      <Show
        when={props.publicMode}
        fallback={
          <>
            <p class="quiet">Each key connects an MCP client to every chat.</p>
            <form
              class="key-create"
              onSubmit={(event) => {
                event.preventDefault();
                props.actions.createKey();
              }}
            >
              <div>
                <label for="key-name">Key name</label>
                <input
                  id="key-name"
                  required
                  maxlength="120"
                  placeholder="Session agent"
                  value={props.state.name}
                  disabled={props.state.busy || !!props.state.shown}
                  onInput={(event) =>
                    props.actions.keyName(event.currentTarget.value)}
                />
              </div>
              <button
                type="submit"
                class="primary"
                data-action="create-key"
                disabled={props.state.busy || !!props.state.shown}
              >
                Create key
              </button>
            </form>
            <Show when={props.state.shown}>
              {(shown) => (
                <section class="once-key" aria-label="New API key">
                  <h2>Save this key now</h2>
                  <p>
                    It is shown only once. Put it in your agent's environment as
                    DELTA_CHAT_MCP_KEY.
                  </p>
                  <code data-once-key>{shown().key}</code>
                  <div class="actions">
                    <button
                      type="button"
                      data-action="copy-key"
                      disabled={props.state.busy}
                      onClick={() => props.actions.copyKey()}
                    >
                      Copy key
                    </button>
                    <button
                      type="button"
                      data-action="dismiss-key"
                      onClick={() => props.actions.dismissKey()}
                    >
                      I've saved it
                    </button>
                  </div>
                </section>
              )}
            </Show>
            <div class="table-scroll">
              <table>
                <caption>API keys</caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th>
                      <span class="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For
                    each={props.state.rows}
                    fallback={
                      <tr>
                        <td colspan="4" class="quiet">
                          No keys yet. Create one for your agent.
                        </td>
                      </tr>
                    }
                  >
                    {(key) => (
                      <tr>
                        <td>{key.name}</td>
                        <td>{key.createdText}</td>
                        <td>
                          {key.lastUsedText}
                        </td>
                        <td>
                          <Show
                            when={props.state.confirm === key.id}
                            fallback={
                              <button
                                type="button"
                                class="small-button"
                                data-action="ask-delete"
                                disabled={props.state.busy}
                                onClick={() =>
                                  props.actions.confirmDelete(key.id)}
                              >
                                Delete
                              </button>
                            }
                          >
                            <div class="delete-confirm">
                              <span>Delete {key.name}?</span>
                              <button
                                type="button"
                                data-action="cancel-delete"
                                disabled={props.state.busy}
                                onClick={() =>
                                  props.actions.confirmDelete(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                data-action="delete-key"
                                disabled={props.state.busy}
                                onClick={() => props.actions.deleteKey()}
                              >
                                Delete key
                              </button>
                            </div>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <button
              class="text-button"
              type="button"
              disabled={props.state.busy}
              onClick={() => props.actions.reloadKeys()}
            >
              Refresh last used
            </button>
          </>
        }
      >
        <p class="public-note">
          Public access is on. MCP is open to your LAN; no API key is needed.
        </p>
      </Show>
      <Show when={props.state.error}>
        <p role="alert" class="error">{props.state.error}</p>
      </Show>
      <p role="status" class="notice">{props.state.notice}</p>
      <section class="connect-config">
        <h2>Connect OpenCode</h2>
        <p class="quiet">
          Add this entry to your configuration. Enable it when you want the
          agent to join.
        </p>
        <pre><code>{props.config}</code></pre>
        <button
          type="button"
          data-action="copy-config"
          disabled={props.state.busy}
          onClick={() => props.actions.copyConfig()}
        >
          Copy configuration
        </button>
      </section>
    </section>
  );
}
