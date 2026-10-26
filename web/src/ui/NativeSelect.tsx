// SPDX-License-Identifier: LGPL-3.0-only
import type { JSX } from "@solidjs/web";

/** Native semantics and full hit target; only the arrow painting is ours. */
export function NativeSelect(
  props: JSX.SelectHTMLAttributes<HTMLSelectElement>,
) {
  return (
    <span class="native-select">
      <select {...props} />
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1 5L8 12L15 5" />
      </svg>
    </span>
  );
}
