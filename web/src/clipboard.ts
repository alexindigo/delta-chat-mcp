// SPDX-License-Identifier: LGPL-3.0-only
/** Copy has a real plain-HTTP path; no secure-context API is required. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* Try the HTTP-capable path. */ }
  }
  const active = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from(
      { length: selection.rangeCount },
      (_, i) => selection.getRangeAt(i).cloneRange(),
    )
    : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-label", "Copy buffer");
  field.style.cssText = "position:fixed;inset:0;width:1px;height:1px;opacity:0";
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy")) {
      throw new Error(
        "Copy unavailable. Select the text and copy it manually.",
      );
    }
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}
