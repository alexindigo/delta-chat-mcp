// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import type { Theme, ThemeChoice } from "./theme.ts";
import { THEMES } from "./palette.ts";
export const themeIds: ThemeChoice[] = [
  "system",
  ...THEMES.map((theme) => theme.id),
];
/** Plain picker workflow; the view owns only DOM focus. */
export function themeControl(theme: Theme) {
  const [state, setState] = createSignal(theme.state);
  const [open, setOpen] = createSignal(false);
  const [focused, setFocused] = createSignal<ThemeChoice>(theme.choice);
  theme.subscribe(setState);
  return {
    state,
    open,
    focused,
    show() {
      setFocused(theme.choice);
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    focus(id: ThemeChoice) {
      setFocused(id);
    },
    move(id: ThemeChoice, key: string) {
      const index = themeIds.indexOf(id);
      let next: ThemeChoice | undefined;
      if (key === "Home") next = themeIds[0];
      if (key === "End") next = themeIds.at(-1);
      if (key === "ArrowRight" || key === "ArrowDown") {
        next = themeIds[(index + 1) % themeIds.length];
      }
      if (key === "ArrowLeft" || key === "ArrowUp") {
        next = themeIds[(index - 1 + themeIds.length) % themeIds.length];
      }
      if (next) setFocused(next);
      return next;
    },
    choose(id: ThemeChoice) {
      theme.choose(id);
      setFocused(id);
    },
  };
}
