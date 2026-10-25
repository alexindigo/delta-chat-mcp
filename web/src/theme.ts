// SPDX-License-Identifier: LGPL-3.0-only
export type ThemeChoice = "system" | "light" | "dark";
export interface ThemePort {
  read(): string | null;
  write(choice: ThemeChoice): void;
  isDark(): boolean;
  watch(listener: () => void): () => void;
  apply(dark: boolean): void;
}
export const themeChoice = (value: string | null): ThemeChoice =>
  value === "dark" || value === "light" ? value : "system";

/** The single runtime owner of storage, OS preference and document theme. */
export class Theme {
  choice: ThemeChoice = "system";
  #off: () => void;
  constructor(private port: ThemePort) {
    try {
      this.choice = themeChoice(port.read());
    } catch { /* Private storage may be disabled. */ }
    this.apply();
    this.#off = port.watch(() => {
      if (this.choice === "system") this.apply();
    });
  }
  private apply() {
    this.port.apply(
      this.choice === "dark" ||
        (this.choice === "system" && this.port.isDark()),
    );
  }
  choose(choice: ThemeChoice) {
    this.choice = choice;
    try {
      this.port.write(choice);
    } catch { /* Keep the page-lifetime choice. */ }
    this.apply();
  }
  close() {
    this.#off();
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
    apply: (dark) => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.querySelector('meta[name="theme-color"]')?.setAttribute(
        "content",
        dark ? "#18263b" : "#eaf0f7",
      );
    },
  });
}
