// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import type { Theme, ThemeChoice } from "./theme.ts";
export function themeControl(theme: Theme) {
  const [choice, setChoice] = createSignal(theme.choice);
  return {
    choice,
    choose(id: ThemeChoice) {
      theme.choose(id);
      setChoice(id);
    },
  };
}
