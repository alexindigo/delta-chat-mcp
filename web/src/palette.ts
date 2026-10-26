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
export function palette(dark: boolean) {
  const raw = dark ? GLOBNOTES_DARK : GLOBNOTES_LIGHT;
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
