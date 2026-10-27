// SPDX-License-Identifier: LGPL-3.0-only
// Default colors and statusInk algorithm adapted from Globnotes client/themes.js,
// Copyright (C) 2026 Alex Indigo. See docs/palette.md for source provenance.

export const GLOBNOTES_LIGHT = {
  brand: "#0284c7",
  background: "#ffffff",
  elevated: "#f3f4f5",
  text: "#2c3139",
  muted: "#8891a1",
  border: "#eceef0",
} as const;
export const GLOBNOTES_DARK = {
  brand: "#38bdf8",
  background: "#22262c",
  elevated: "#2c3139",
  text: "#c1c7d0",
  muted: "#8891a1",
  border: "#5e6b80",
} as const;

/** Product-consumed colors ported from Globnotes client/themes.js.
 * Copyright (C) 2026 Alex Indigo, LGPL-3.0-only; see docs/palette.md.
 */
export const THEMES = [
  {
    id: "globnotes-light",
    label: "Default Light",
    family: "Default",
    variant: "Light",
    mode: "light",
    colors: GLOBNOTES_LIGHT,
  },
  {
    id: "globnotes-dark",
    label: "Default Dark",
    family: "Default",
    variant: "Dark",
    mode: "dark",
    colors: GLOBNOTES_DARK,
  },
  {
    id: "dracula",
    label: "Dracula",
    family: "Dracula",
    variant: "Dracula",
    mode: "dark",
    colors: {
      brand: "#bd93f9",
      background: "#282a36",
      elevated: "#44475a",
      text: "#f8f8f2",
      muted: "#6272a4",
      border: "#44475a",
    },
  },
  {
    id: "dracula-alucard",
    label: "Dracula Alucard",
    family: "Dracula",
    variant: "Alucard",
    mode: "light",
    colors: {
      brand: "#644ac9",
      background: "#fffbeb",
      elevated: "#efe9d9",
      text: "#1f1f1f",
      muted: "#6c664b",
      border: "#cfcfde",
    },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    family: "Catppuccin",
    variant: "Latte",
    mode: "light",
    colors: {
      brand: "#1e66f5",
      background: "#eff1f5",
      elevated: "#e6e9ef",
      text: "#4c4f69",
      muted: "#6c6f85",
      border: "#bcc0cc",
    },
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    family: "Catppuccin",
    variant: "Frappé",
    mode: "dark",
    colors: {
      brand: "#8caaee",
      background: "#303446",
      elevated: "#414559",
      text: "#c6d0f5",
      muted: "#a5adce",
      border: "#51576d",
    },
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    family: "Catppuccin",
    variant: "Macchiato",
    mode: "dark",
    colors: {
      brand: "#8aadf4",
      background: "#24273a",
      elevated: "#363a4f",
      text: "#cad3f5",
      muted: "#a5adcb",
      border: "#494d64",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    family: "Catppuccin",
    variant: "Mocha",
    mode: "dark",
    colors: {
      brand: "#89b4fa",
      background: "#1e1e2e",
      elevated: "#313244",
      text: "#cdd6f4",
      muted: "#a6adc8",
      border: "#45475a",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    family: "Solarized",
    variant: "Light",
    mode: "light",
    colors: {
      brand: "#268bd2",
      background: "#fdf6e3",
      elevated: "#eee8d5",
      text: "#657b83",
      muted: "#93a1a1",
      border: "#eee8d5",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    family: "Solarized",
    variant: "Dark",
    mode: "dark",
    colors: {
      brand: "#268bd2",
      background: "#002b36",
      elevated: "#073642",
      text: "#839496",
      muted: "#657b83",
      border: "#073642",
    },
  },
  {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    family: "Gruvbox",
    variant: "Light",
    mode: "light",
    colors: {
      brand: "#af3a03",
      background: "#fbf1c7",
      elevated: "#ebdbb2",
      text: "#3c3836",
      muted: "#928374",
      border: "#d5c4a1",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    family: "Gruvbox",
    variant: "Dark",
    mode: "dark",
    colors: {
      brand: "#fe8019",
      background: "#282828",
      elevated: "#3c3836",
      text: "#ebdbb2",
      muted: "#928374",
      border: "#504945",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    family: "Tokyo Night",
    variant: "Night",
    mode: "dark",
    colors: {
      brand: "#7aa2f7",
      background: "#1a1b26",
      elevated: "#24283b",
      text: "#a9b1d6",
      muted: "#565f89",
      border: "#24283b",
    },
  },
  {
    id: "tokyo-night-light",
    label: "Tokyo Night Light",
    family: "Tokyo Night",
    variant: "Light",
    mode: "light",
    colors: {
      brand: "#2959aa",
      background: "#e6e7ed",
      elevated: "#d5d6db",
      text: "#343b58",
      muted: "#6c6e75",
      border: "#d5d6db",
    },
  },
  {
    id: "nord",
    label: "Nord",
    family: "Nord",
    variant: "Nord",
    mode: "dark",
    colors: {
      brand: "#88c0d0",
      background: "#2e3440",
      elevated: "#3b4252",
      text: "#d8dee9",
      muted: "#7b88a1",
      border: "#434c5e",
    },
  },
] as const;
export type ThemeId = typeof THEMES[number]["id"];
export const themeById = (id: ThemeId) =>
  THEMES.find((theme) => theme.id === id)!;

/** Concrete defaults remain resolvable, but share the single System entry. */
export const isDefaultTheme = (id: ThemeId) =>
  themeById(id).family === "Default";
export const pickerThemeId = (id: "system" | ThemeId) =>
  id === "system" || isDefaultTheme(id) ? "system" : id;

const channels = (hex: string) =>
  [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
const luminance = (hex: string) =>
  channels(hex).map((channel) => channel / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
export function contrast(left: string, right: string) {
  const a = luminance(left), b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Globnotes' least-step RGB blend toward the best black/white contrast target. */
export function statusInk(
  preferred: string,
  surfaces: string[],
  threshold = 4.5,
) {
  const minimum = (ink: string) =>
    Math.min(...surfaces.map((surface) => contrast(ink, surface)));
  if (minimum(preferred) >= threshold) return preferred;
  const target = minimum("#ffffff") > minimum("#000000") ? 255 : 0;
  const rgb = channels(preferred);
  for (let step = 1; step <= 255; step++) {
    const candidate = "#" +
      rgb.map((channel) =>
        Math.round(channel + (target - channel) * step / 255).toString(16)
          .padStart(2, "0")
      ).join("");
    if (minimum(candidate) >= threshold) return candidate;
  }
  return target === 255 ? "#ffffff" : "#000000";
}

/** One owner for effective UI roles; CSS contains tested prepaint fallbacks. */
export function palette(id: ThemeId) {
  const theme = themeById(id);
  const defaults = theme.mode === "dark" ? GLOBNOTES_DARK : GLOBNOTES_LIGHT;
  const raw = { ...defaults, ...theme.colors };
  const surfaces = [raw.background, raw.elevated];
  const ink = statusInk(raw.text, surfaces);
  const quiet = statusInk(raw.muted, surfaces);
  const accent = statusInk(raw.brand, surfaces);
  return {
    desk: raw.background,
    sheet: raw.elevated,
    ink,
    quiet,
    brand: raw.brand,
    accent,
    line: raw.border,
    "control-line": statusInk(raw.border, surfaces, 3),
    "on-accent": statusInk(raw.background, [accent]),
    rail: raw.elevated,
    "rail-ink": ink,
    "rail-quiet": quiet,
    "modal-veil": GLOBNOTES_DARK.background + "80",
  };
}

/** Values-only preview data: exactly the same effective roles as the desk. */
export const themePreviews = THEMES.map((theme) => ({
  ...theme,
  vars: Object.fromEntries(
    Object.entries(palette(theme.id)).map((
      [role, value],
    ) => [`--${role}`, value]),
  ),
}));
export const defaultPreviews = themePreviews.filter((theme) =>
  isDefaultTheme(theme.id)
);
export const selectableThemes = themePreviews.filter((theme) =>
  !isDefaultTheme(theme.id)
);
export const themeFamilies = [
  ...new Set(selectableThemes.map((theme) => theme.family)),
]
  .map((label) => ({
    label,
    themes: selectableThemes.filter((theme) => theme.family === label),
  }));
