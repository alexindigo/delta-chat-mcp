// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Theme } from "../../web/src/theme.ts";

Deno.test("theme stores the choice id, follows OS live only in system and survives storage errors", () => {
  let stored: string | null = null,
    osDark = true,
    applied = false,
    unavailable = false,
    stopped = false;
  let changed = () => {};
  const theme = new Theme({
    read: () => stored,
    write: (value) => {
      if (unavailable) throw new Error("storage disabled");
      stored = value;
    },
    isDark: () => osDark,
    watch: (listener) => {
      changed = listener;
      return () => {
        stopped = true;
      };
    },
    apply: (value) => {
      applied = value;
    },
  });
  assertEquals(theme.choice, "system");
  assertEquals(applied, true);
  theme.choose("light");
  osDark = false;
  changed();
  osDark = true;
  changed();
  assertEquals(applied, false);
  assertEquals(stored, "light");
  theme.choose("system");
  assertEquals(stored, "system");
  assertEquals(applied, true);
  osDark = false;
  changed();
  assertEquals(applied, false);
  unavailable = true;
  theme.choose("dark");
  assertEquals(applied, true);
  assertEquals(theme.choice, "dark");
  theme.close();
  assertEquals(stopped, true);
  let fallback = false;
  const privateTheme = new Theme({
    read: () => {
      throw new Error("disabled");
    },
    write: () => {},
    isDark: () => true,
    watch: () => () => {},
    apply: (dark) => {
      fallback = dark;
    },
  });
  assertEquals(fallback, true);
  privateTheme.close();
});
