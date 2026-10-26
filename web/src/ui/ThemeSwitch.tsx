// SPDX-License-Identifier: LGPL-3.0-only
export function ThemeEntry(
  props: { label: string; disabled: boolean; open: () => void },
) {
  return (
    <button
      type="button"
      data-action="open-theme"
      aria-haspopup="dialog"
      disabled={props.disabled}
      onClick={() => props.open()}
    >
      Theme: {props.label}
    </button>
  );
}
