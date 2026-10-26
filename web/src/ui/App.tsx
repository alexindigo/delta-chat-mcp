// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { AppControl } from "../app-control.ts";
import type { AccessState } from "../access.ts";
import type { KeysState } from "../keys.ts";
import type { Screen } from "../location.ts";
import type { ThemeState } from "../theme.ts";
import { ThemeDialog } from "./ThemeDialog.tsx";
import { ThemeEntry } from "./ThemeSwitch.tsx";
import { AccessScreen } from "./AccessScreen.tsx";
import { KeysScreen } from "./KeysScreen.tsx";
import { IdentityScreen } from "./IdentityScreen.tsx";
import { ContactsScreen } from "./ContactsScreen.tsx";
import { ChatScreen } from "./ChatScreen.tsx";
import { StatusScreen } from "./StatusScreen.tsx";
import { KeyHandoff } from "./KeyHandoff.tsx";
import type { MessagingState } from "../messaging.ts";
import type { RelayState } from "../relays.ts";
import type { SetupProgress } from "../onboarding.ts";
import { SetupSteps } from "./SetupSteps.tsx";
import type { RoomState } from "../rooms.ts";
import { RoomDialog } from "./RoomDialog.tsx";
export function App(
  props: {
    access: AccessState;
    keys: KeysState;
    screen: Screen;
    messaging: MessagingState;
    relays: RelayState;
    room: RoomState;
    activeDialog: "key" | "room" | "theme" | null;
    relayOptions: string[];
    progress: SetupProgress;
    waiting: boolean;
    routeError: string;
    logoutConfirm: boolean;
    config: string;
    theme: ThemeState;
    themeControl: AppControl["theme"];
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
          <ThemeEntry
            label={props.theme.label}
            disabled={!!props.activeDialog}
            open={props.actions.openTheme}
          />
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
                    { id: "identity", href: "/identity", label: "Identity" },
                    { id: "contacts", href: "/contacts", label: "Contacts" },
                    { id: "chats", href: "/chats", label: "Chats" },
                    { id: "keys", href: "/keys", label: "API keys" },
                    { id: "status", href: "/status", label: "Status" },
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
                <div class="connection-status" aria-live="polite">
                  <a href="/status">{props.messaging.connection}</a>
                </div>
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
                <SetupSteps progress={props.progress} screen={props.screen} />
                <Show
                  when={!props.waiting}
                  fallback={<p role="status">Checking setup…</p>}
                >
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
                                  <StatusScreen
                                    state={props.messaging}
                                    refresh={props.actions.refreshMessaging}
                                  />
                                }
                              >
                                <ChatScreen
                                  state={props.messaging}
                                  roomDisabled={!!props.activeDialog}
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
                          relays={props.relays}
                          relayOptions={props.relayOptions}
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
                </Show>
              </main>
            </div>
          </Show>
        </Show>
      </Show>
      <footer class="app-footer">
        Private relay on your LAN. Plain HTTP sends credentials unencrypted.
      </footer>
      <Show
        when={props.activeDialog === "key" ? props.keys.shown : null}
        fallback={
          <Show
            when={props.activeDialog === "room"}
            fallback={
              <Show when={props.activeDialog === "theme"}>
                <ThemeDialog
                  state={props.theme}
                  focused={props.themeControl.focused()}
                  control={props.themeControl}
                />
              </Show>
            }
          >
            <RoomDialog state={props.room} actions={props.actions} />
          </Show>
        }
      >
        {(shown) => (
          <KeyHandoff
            value={shown().key}
            copying={props.keys.copying}
            copied={props.keys.copied}
            error={props.keys.copyError}
            copy={props.actions.copyKey}
            acknowledge={props.actions.dismissKey}
          />
        )}
      </Show>
    </div>
  );
}
