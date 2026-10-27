// SPDX-License-Identifier: LGPL-3.0-only
import {
  isDefaultTheme,
  palette,
  pickerThemeId,
  themeById,
  type ThemeId,
  THEMES,
} from "./palette.ts";
export type ThemeChoice = "system" | ThemeId;
export interface ThemeState {
  choice: ThemeChoice;
  resolvedId: ThemeId;
  mode: "light" | "dark";
  label: string;
  systemLabel: string;
  selectedId: ThemeChoice;
  systemEntryLabel: string;
  systemAriaLabel: string;
  systemDescription: string;
}
export interface ThemePort {
  read(): string | null;
  write(choice: ThemeChoice): void;
  isDark(): boolean;
  watch(listener: () => void): () => void;
  apply(id: ThemeId): void;
}
export function themeChoice(value: string | null): ThemeChoice {
  if (value === "light") return "globnotes-light";
  if (value === "dark") return "globnotes-dark";
  return THEMES.some((theme) => theme.id === value)
    ? value as ThemeId
    : "system";
}

/** The single runtime owner of storage, OS preference and document theme. */
export class Theme {
  choice: ThemeChoice = "system";
  #off: () => void;
  #listeners = new Set<(state: ThemeState) => void>();
  constructor(private port: ThemePort) {
    try {
      this.choice = themeChoice(port.read());
    } catch { /* Private storage may be disabled. */ }
    this.apply();
    this.#off = port.watch(() => {
      if (this.choice === "system") this.apply();
      else this.publish();
    });
  }
  get state(): ThemeState {
    const systemId = this.port.isDark() ? "globnotes-dark" : "globnotes-light";
    const resolvedId = this.choice === "system" ? systemId : this.choice;
    const theme = themeById(resolvedId);
    const fixedDefault = this.choice !== "system" &&
      isDefaultTheme(this.choice);
    const systemLabel = themeById(systemId).label;
    return {
      choice: this.choice,
      resolvedId,
      mode: theme.mode,
      label: this.choice === "system" ? "System" : theme.label,
      systemLabel,
      selectedId: pickerThemeId(this.choice),
      systemEntryLabel: fixedDefault
        ? `Saved fixed ${theme.variant}`
        : "System — follows your device",
      systemAriaLabel: fixedDefault
        ? `System (saved fixed ${theme.variant}; select System to follow your device)`
        : "System (follows OS)",
      systemDescription: fixedDefault
        ? `Saved fixed ${theme.label}. Select System to follow your device.`
        : `Now showing ${systemLabel}`,
    };
  }
  subscribe(listener: (state: ThemeState) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  private publish() {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }
  private apply() {
    this.port.apply(this.state.resolvedId);
    this.publish();
  }
  choose(choice: ThemeChoice) {
    this.choice = themeChoice(choice);
    try {
      this.port.write(this.choice);
    } catch { /* Keep the page-lifetime choice. */ }
    this.apply();
  }
  close() {
    this.#off();
    this.#listeners.clear();
  }
}
export function browserTheme(): Theme {
  const query = matchMedia("(prefers-color-scheme: dark)");
  return new Theme({
    read: () => localStorage.getItem("delta-chat-mcp-theme"),
    write: (id) => localStorage.setItem("delta-chat-mcp-theme", id),
    isDark: () => query.matches,
    watch: (listener) => {
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    apply: (id) => {
      const colors = palette(id), dark = themeById(id).mode === "dark";
      for (const [role, value] of Object.entries(colors)) {
        document.documentElement.style.setProperty(`--${role}`, value);
      }
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.dataset.theme = id;
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.querySelector('meta[name="theme-color"]')?.setAttribute(
        "content",
        colors.desk,
      );
    },
  });
}
