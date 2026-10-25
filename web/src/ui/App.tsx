// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { AppControl } from "../app-control.ts";
import type { AccessState } from "../access.ts";
import type { KeysState } from "../keys.ts";
import type { Screen } from "../location.ts";
import type { ThemeChoice } from "../theme.ts";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { AccessScreen } from "./AccessScreen.tsx";
import { KeysScreen } from "./KeysScreen.tsx";
import { IdentityScreen } from "./IdentityScreen.tsx";
import { ContactsScreen } from "./ContactsScreen.tsx";
import { ChatScreen } from "./ChatScreen.tsx";
import type { MessagingState } from "../messaging.ts";
export function App(
  props: {
    access: AccessState;
    keys: KeysState;
    screen: Screen;
    messaging: MessagingState;
    routeError: string;
    logoutConfirm: boolean;
    config: string;
    theme: ThemeChoice;
    chooseTheme: (id: ThemeChoice) => void;
    actions: AppControl["actions"];
  },
) {
  return (
    <div class="app">
      <header class="app-header">
        <a class="brand" href="/">
          <strong>delta chat</strong>
          <span>relay desk</span>
        </a>
        <div class="header-actions">
          <ThemeSwitch choice={props.theme} choose={props.chooseTheme} />
          <Show
            when={props.access.session?.authenticated &&
              props.access.session?.mode !== "public"}
          >
            <button
              type="button"
              data-action="logout"
              disabled={props.access.busy}
              onClick={() => props.actions.logout()}
            >
              Log out
            </button>
          </Show>
        </div>
      </header>
      <Show
        when={!props.access.loading}
        fallback={<main class="loading" role="status">Opening relay…</main>}
      >
        <Show
          when={props.access.session}
          fallback={
            <main class="loading">
              <h1>Relay unavailable</h1>
              <p role="alert">{props.access.error}</p>
              <button
                type="button"
                onClick={() => props.actions.refresh()}
              >
                Try again
              </button>
            </main>
          }
        >
          <Show
            when={props.access.session?.authenticated &&
              !props.access.session?.setupRequired}
            fallback={
              <AccessScreen state={props.access} actions={props.actions} />
            }
          >
            <div class="workspace">
              <nav class="nav-rail" aria-label="Relay">
                <For
                  each={[
                    { id: "keys", href: "/keys", label: "API keys" },
                    { id: "identity", href: "/identity", label: "Identity" },
                    { id: "contacts", href: "/contacts", label: "Contacts" },
                    { id: "chats", href: "/chats", label: "Chats" },
                  ]}
                >
                  {(item) => (
                    <a
                      href={item.href}
                      aria-current={props.screen === item.id
                        ? "page"
                        : undefined}
                    >
                      {item.label}
                    </a>
                  )}
                </For>
              </nav>
              <main class="working-sheet">
                <Show when={props.logoutConfirm}>
                  <section
                    class="departure-confirm"
                    role="alertdialog"
                    aria-label="Discard unsaved work?"
                  >
                    <h2>Discard unsaved work and log out?</h2>
                    <p>
                      Unsent drafts, form input and an unsaved shown-once key
                      are kept only in this page. Save them before leaving.
                    </p>
                    <button
                      type="button"
                      data-action="keep-work"
                      onClick={() => props.actions.cancelLogout()}
                    >
                      Keep working
                    </button>
                    <button
                      type="button"
                      data-action="discard-logout"
                      onClick={() => props.actions.discardLogout()}
                    >
                      Discard and log out
                    </button>
                  </section>
                </Show>
                <Show when={props.keys.shown && props.screen !== "keys"}>
                  <p class="pending-key" role="status">
                    An API key is waiting to be saved.{" "}
                    <a href="/keys">Return to API keys</a>
                  </p>
                </Show>
                <Show when={props.routeError}>
                  <p class="error" role="alert">{props.routeError}</p>
                </Show>
                <Show when={props.messaging.error}>
                  <p class="error" role="alert">
                    {props.messaging.error}{" "}
                    <button
                      type="button"
                      onClick={() => props.actions.refreshMessaging()}
                    >
                      Refresh messaging
                    </button>
                  </p>
                </Show>
                <Show when={props.access.error}>
                  <p role="alert" class="error">{props.access.error}</p>
                </Show>
                <Show
                  when={props.screen === "keys"}
                  fallback={
                    <Show
                      when={props.screen === "identity"}
                      fallback={
                        <Show
                          when={props.screen === "contacts"}
                          fallback={
                            <Show
                              when={props.screen === "chats"}
                              fallback={
                                <section class="future-screen">
                                  <h1>
                                    {props.screen === "identity"
                                      ? "Relay identity"
                                      : props.screen === "contacts"
                                      ? "Contacts"
                                      : "Chats"}
                                  </h1>
                                  <p>Messaging screens arrive in M3.</p>
                                  <p class="quiet">
                                    Use the MCP tools for messaging now.
                                    Identity creation and phone pairing will be
                                    available here.
                                  </p>
                                  <a href="/keys">Set up agent access</a>
                                </section>
                              }
                            >
                              <ChatScreen
                                state={props.messaging}
                                actions={props.actions}
                              />
                            </Show>
                          }
                        >
                          <ContactsScreen
                            state={props.messaging}
                            actions={props.actions}
                          />
                        </Show>
                      }
                    >
                      <IdentityScreen
                        state={props.messaging}
                        actions={props.actions}
                      />
                    </Show>
                  }
                >
                  <KeysScreen
                    state={props.keys}
                    publicMode={props.access.session?.mode === "public"}
                    config={props.config}
                    actions={props.actions}
                  />
                </Show>
              </main>
            </div>
          </Show>
        </Show>
      </Show>
      <footer class="app-footer">
        Private relay on your LAN. Plain HTTP sends credentials unencrypted.
      </footer>
    </div>
  );
}
