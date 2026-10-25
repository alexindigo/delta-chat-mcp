// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { ThemeChoice } from "../theme.ts";
export function ThemeSwitch(
  props: { choice: ThemeChoice; choose: (id: ThemeChoice) => void },
) {
  return (
    <div class="theme-switch" role="group" aria-label="Color theme">
      <For each={["system", "light", "dark"] as const}>
        {(id) => (
          <button
            type="button"
            data-theme={id}
            aria-pressed={props.choice === id ? "true" : "false"}
            onClick={() => props.choose(id)}
          >
            {id === "system" ? "System" : id === "light" ? "Light" : "Dark"}
          </button>
        )}
      </For>
    </div>
  );
}
