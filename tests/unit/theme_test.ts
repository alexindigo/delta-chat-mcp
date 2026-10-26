// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Theme, themeChoice } from "../../web/src/theme.ts";
import {
  contrast,
  GLOBNOTES_DARK,
  GLOBNOTES_LIGHT,
  palette,
  themeFamilies,
  themePreviews,
  THEMES,
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
  const blocks = [
    ...css.matchAll(/html\[data-theme="([\w-]+)"\]\s*\{([^}]+)\}/g),
  ];
  assertEquals(blocks.length, 15);
  const head = await Deno.readTextFile("web/index.html");
  const metadata = Object.fromEntries(
    [...head.matchAll(/"([\w-]+)": \["(light|dark)", "(#[\da-f]+)"\]/g)].map(
      (m) => [m[1], [m[2], m[3]]],
    ),
  );
  assertEquals(Object.keys(metadata).sort(), THEMES.map((t) => t.id).sort());
  for (const theme of THEMES) {
    const colors = palette(theme.id);
    const block = blocks.find((b) => b[1] === theme.id)!;
    const fallback = Object.fromEntries(
      [...block[2].matchAll(/--([\w-]+):\s*(#[\da-f]+);/g)].map((
        match,
      ) => [match[1], match[2]]),
    );
    for (const [role, value] of Object.entries(colors)) {
      assertEquals(fallback[role], value, `Prepaint ${theme.id}:${role}`);
    }
    assertEquals(metadata[theme.id], [theme.mode, colors.desk]);
    assertEquals(
      themePreviews.find((p) => p.id === theme.id)!.vars,
      Object.fromEntries(Object.entries(colors).map(([r, v]) => [`--${r}`, v])),
    );
    for (const surface of [colors.desk, colors.sheet]) {
      for (const role of ["ink", "quiet", "accent"] as const) {
        assert(
          contrast(colors[role], surface) >= 4.5,
          `${theme.id}:${role}:${surface}`,
        );
      }
      assert(contrast(colors["control-line"], surface) >= 3);
    }
    assert(contrast(colors["on-accent"], colors.accent) >= 4.5);
    assertEquals(
      colors.brand,
      theme.colors.brand,
    );
  }
});

Deno.test("theme stores the choice id, follows OS live only in system and survives storage errors", () => {
  let stored: string | null = null,
    osDark = true,
    applied = "",
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
  assertEquals(applied, "globnotes-dark");
  const updates: unknown[] = [];
  theme.subscribe((state) => updates.push(state));
  theme.choose("globnotes-light");
  osDark = false;
  changed();
  osDark = true;
  changed();
  assertEquals(applied, "globnotes-light");
  assertEquals(stored, "globnotes-light");
  theme.choose("system");
  assertEquals(stored, "system");
  assertEquals(applied, "globnotes-dark");
  osDark = false;
  changed();
  assertEquals(applied, "globnotes-light");
  assertEquals(theme.state.label, "System");
  assertEquals(theme.state.systemLabel, "Globnotes Light");
  assertEquals((updates.at(-1) as { mode: string }).mode, "light");
  unavailable = true;
  theme.choose("globnotes-dark");
  assertEquals(applied, "globnotes-dark");
  assertEquals(theme.choice, "globnotes-dark");
  theme.choose("dracula-alucard");
  osDark = true;
  changed();
  assertEquals(applied, "dracula-alucard");
  assertEquals(theme.state.label, "Dracula Alucard");
  assertEquals(theme.state.systemLabel, "Globnotes Dark");
  theme.close();
  assertEquals(stopped, true);
  let fallback = "";
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
  assertEquals(fallback, "globnotes-dark");
  privateTheme.close();
});

Deno.test("source catalog has exact named metadata, seven families, aliases and invalid fallback", () => {
  // Independently transcribed source metadata; no Globnotes runtime dependency.
  assertEquals(
    THEMES.map((t) => [t.id, t.label, t.family, t.variant, t.mode]),
    [
      ["globnotes-light", "Globnotes Light", "Globnotes", "Light", "light"],
      ["globnotes-dark", "Globnotes Dark", "Globnotes", "Dark", "dark"],
      ["dracula", "Dracula", "Dracula", "Dracula", "dark"],
      ["dracula-alucard", "Dracula Alucard", "Dracula", "Alucard", "light"],
      ["catppuccin-latte", "Catppuccin Latte", "Catppuccin", "Latte", "light"],
      [
        "catppuccin-frappe",
        "Catppuccin Frappé",
        "Catppuccin",
        "Frappé",
        "dark",
      ],
      [
        "catppuccin-macchiato",
        "Catppuccin Macchiato",
        "Catppuccin",
        "Macchiato",
        "dark",
      ],
      ["catppuccin-mocha", "Catppuccin Mocha", "Catppuccin", "Mocha", "dark"],
      ["solarized-light", "Solarized Light", "Solarized", "Light", "light"],
      ["solarized-dark", "Solarized Dark", "Solarized", "Dark", "dark"],
      ["gruvbox-light", "Gruvbox Light", "Gruvbox", "Light", "light"],
      ["gruvbox-dark", "Gruvbox Dark", "Gruvbox", "Dark", "dark"],
      ["tokyo-night", "Tokyo Night", "Tokyo Night", "Night", "dark"],
      [
        "tokyo-night-light",
        "Tokyo Night Light",
        "Tokyo Night",
        "Light",
        "light",
      ],
      ["nord", "Nord", "Nord", "Nord", "dark"],
    ],
  );
  assertEquals(themeFamilies.map((f) => f.label), [
    "Globnotes",
    "Dracula",
    "Catppuccin",
    "Solarized",
    "Gruvbox",
    "Tokyo Night",
    "Nord",
  ]);
  assertEquals(themeChoice("light"), "globnotes-light");
  assertEquals(themeChoice("dark"), "globnotes-dark");
  for (const invalid of [null, "", "invalid", "__proto__", "constructor"]) {
    assertEquals(themeChoice(invalid), "system");
  }
  for (const t of THEMES) assertEquals(themeChoice(t.id), t.id);
  // Consumed source colors in brand/background/elevated/text/muted/border order.
  // Kept independently of the effective-role resolver/static copies.
  assertEquals(
    THEMES.slice(2).map((t) =>
      [
        t.colors.brand,
        t.colors.background,
        t.colors.elevated,
        t.colors.text,
        t.colors.muted,
        t.colors.border,
      ].join(" ")
    ),
    [
      "#bd93f9 #282a36 #44475a #f8f8f2 #6272a4 #44475a",
      "#644ac9 #fffbeb #efe9d9 #1f1f1f #6c664b #cfcfde",
      "#1e66f5 #eff1f5 #e6e9ef #4c4f69 #6c6f85 #bcc0cc",
      "#8caaee #303446 #414559 #c6d0f5 #a5adce #51576d",
      "#8aadf4 #24273a #363a4f #cad3f5 #a5adcb #494d64",
      "#89b4fa #1e1e2e #313244 #cdd6f4 #a6adc8 #45475a",
      "#268bd2 #fdf6e3 #eee8d5 #657b83 #93a1a1 #eee8d5",
      "#268bd2 #002b36 #073642 #839496 #657b83 #073642",
      "#af3a03 #fbf1c7 #ebdbb2 #3c3836 #928374 #d5c4a1",
      "#fe8019 #282828 #3c3836 #ebdbb2 #928374 #504945",
      "#7aa2f7 #1a1b26 #24283b #a9b1d6 #565f89 #24283b",
      "#2959aa #e6e7ed #d5d6db #343b58 #6c6e75 #d5d6db",
      "#88c0d0 #2e3440 #3b4252 #d8dee9 #7b88a1 #434c5e",
    ],
  );
});
