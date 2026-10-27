// SPDX-License-Identifier: LGPL-3.0-only
// Picker semantics adapted from Globnotes AppearanceSettingsPage.vue (Alex Indigo).
import { For, Show } from "solid-js";
import { defaultPreviews, themeFamilies } from "../palette.ts";
import type { ThemeChoice, ThemeState } from "../theme.ts";
import type { themeControl } from "../theme-control.ts";
import { Dialog } from "./Dialog.tsx";

function ConversationPreview(
  props: { vars: Record<string, string>; id: string },
) {
  return (
    <span
      class="theme-conversation"
      style={props.vars}
      data-preview={props.id}
      aria-hidden="true"
    >
      <span class="theme-preview-title">Conversation</span>
      <span class="theme-preview-incoming">Are you there?</span>
      <span class="theme-preview-outgoing">Right here.</span>
      <span class="theme-preview-meta">Encrypted · just now</span>
    </span>
  );
}

export function ThemeDialog(props: {
  state: ThemeState;
  focused: ThemeChoice;
  control: ReturnType<typeof themeControl>;
}) {
  const tiles = new Map<ThemeChoice, HTMLButtonElement>();
  const navigate = (event: KeyboardEvent, id: ThemeChoice) => {
    const next = props.control.move(id, event.key);
    if (next) {
      event.preventDefault();
      tiles.get(next)?.focus();
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.control.choose(id);
    }
  };
  return (
    <Dialog
      class="theme-dialog"
      labelledBy="theme-title"
      describedBy="theme-help"
      cancel={() => props.control.close()}
    >
      <div class="theme-dialog-header">
        <div>
          <h2 id="theme-title">Theme</h2>
          <p id="theme-help">
            Choose a palette for this browser. Changes apply immediately.
          </p>
        </div>
        <button
          type="button"
          data-action="theme-done"
          onClick={() => props.control.close()}
        >
          Done
        </button>
      </div>
      <div
        class="theme-picker"
        role="radiogroup"
        aria-label="Theme for this browser"
      >
        <button
          type="button"
          role="radio"
          class="theme-tile theme-system"
          data-theme-id="system"
          aria-label={props.state.systemAriaLabel}
          aria-describedby="theme-system-description"
          aria-checked={props.state.selectedId === "system" ? "true" : "false"}
          tabindex={props.focused === "system" ? 0 : -1}
          autofocus={props.focused === "system"}
          ref={(element) => tiles.set("system", element)}
          onFocus={() => props.control.focus("system")}
          onKeyDown={(event) => navigate(event, "system")}
          onClick={() => props.control.choose("system")}
        >
          <span class="theme-system-pair">
            <For each={defaultPreviews}>
              {(theme) => (
                <span class="theme-system-preview">
                  <ConversationPreview vars={theme.vars} id={theme.id} />
                  <span class="theme-system-caption">{theme.label}</span>
                </span>
              )}
            </For>
          </span>
          <span class="theme-tile-label">
            <span>{props.state.systemEntryLabel}</span>
            <Show when={props.state.selectedId === "system"}>
              <span aria-hidden="true">✓</span>
            </Show>
          </span>
          <span class="theme-system-description" id="theme-system-description">
            {props.state.systemDescription}
          </span>
        </button>
        <For each={themeFamilies}>
          {(family, index) => (
            <section
              role="group"
              class="theme-family"
              aria-labelledby={`theme-family-${index()}`}
            >
              <h3 id={`theme-family-${index()}`}>{family.label}</h3>
              <div class="theme-family-grid">
                <For each={family.themes}>
                  {(theme) => (
                    <button
                      type="button"
                      role="radio"
                      class="theme-tile"
                      data-theme-id={theme.id}
                      aria-label={theme.label}
                      aria-checked={props.state.selectedId === theme.id
                        ? "true"
                        : "false"}
                      tabindex={props.focused === theme.id ? 0 : -1}
                      autofocus={props.focused === theme.id}
                      ref={(element) => tiles.set(theme.id, element)}
                      onFocus={() => props.control.focus(theme.id)}
                      onKeyDown={(event) => navigate(event, theme.id)}
                      onClick={() => props.control.choose(theme.id)}
                    >
                      <ConversationPreview vars={theme.vars} id={theme.id} />
                      <span class="theme-tile-label">
                        <span>{theme.variant}</span>
                        <Show when={props.state.selectedId === theme.id}>
                          <span aria-hidden="true">✓</span>
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  );
}
