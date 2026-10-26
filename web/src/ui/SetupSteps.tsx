// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { SetupProgress } from "../onboarding.ts";
import type { Screen } from "../location.ts";
export function SetupSteps(props: { progress: SetupProgress; screen: Screen }) {
  return (
    <Show when={!props.progress.complete}>
      <section class="setup-steps" aria-label="Setup progress">
        <ol>
          <For each={props.progress.steps}>
            {(step) => (
              <li class={step.done ? "step-done" : ""}>
                <a href={step.href}>{step.label}</a>
                <span>{step.done ? "Ready" : ""}</span>
              </li>
            )}
          </For>
        </ol>
        <Show
          when={props.progress.next && props.progress.next !== props.screen}
        >
          <a
            class="setup-next"
            data-action="setup-next"
            href={`/${props.progress.next}`}
          >
            {props.progress.label}
          </a>
        </Show>
      </section>
    </Show>
  );
}
