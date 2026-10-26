// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Theme } from "../../web/src/theme.ts";
import {
  contrast,
  GLOBNOTES_DARK,
  GLOBNOTES_LIGHT,
  palette,
} from "../../web/src/palette.ts";

Deno.test("Globnotes source pair resolves readable roles on both surfaces and exact prepaint CSS fallbacks", async () => {
  assertEquals(GLOBNOTES_LIGHT, {
    brand: "#0284c7",
    background: "#ffffff",
    elevated: "#f3f4f5",
    text: "#2c3139",
    muted: "#8891a1",
    border: "#eceef0",
  });
  assertEquals(GLOBNOTES_DARK, {
    brand: "#38bdf8",
    background: "#22262c",
    elevated: "#2c3139",
    text: "#c1c7d0",
    muted: "#8891a1",
    border: "#5e6b80",
  });
  const css = await Deno.readTextFile("web/src/styles/tokens.css");
  const blocks = [...css.matchAll(/(?:\:root|html\.dark)\s*\{([^}]+)\}/g)];
  assertEquals(blocks.length, 2);
  for (const [i, dark] of [false, true].entries()) {
    const colors = palette(dark);
    const fallback = Object.fromEntries(
      [...blocks[i][1].matchAll(/--([\w-]+):\s*(#[\da-f]+);/g)].map((
        match,
      ) => [match[1], match[2]]),
    );
    for (const [role, value] of Object.entries(colors)) {
      assertEquals(fallback[role], value, `Prepaint ${dark}:${role}`);
    }
    for (const surface of [colors.desk, colors.sheet]) {
      for (const role of ["ink", "quiet", "accent"] as const) {
        assert(
          contrast(colors[role], surface) >= 4.5,
          `${dark}:${role}:${surface}`,
        );
      }
      assert(contrast(colors["control-line"], surface) >= 3);
    }
    assert(contrast(colors["on-accent"], colors.accent) >= 4.5);
    assertEquals(
      colors.brand,
      dark ? GLOBNOTES_DARK.brand : GLOBNOTES_LIGHT.brand,
    );
  }
});

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
