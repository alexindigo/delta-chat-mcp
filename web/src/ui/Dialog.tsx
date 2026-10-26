// SPDX-License-Identifier: LGPL-3.0-only
import { onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";

/** View-only native top-layer/focus lifetime. Policy belongs to injected intents. */
export function Dialog(props: {
  class?: string;
  labelledBy: string;
  describedBy?: string;
  cancel: () => void;
  children: JSX.Element;
}) {
  let dialog!: HTMLDialogElement;
  onSettled(() => {
    dialog.showModal();
    return () => dialog.close();
  });
  return (
    <dialog
      ref={(element) => dialog = element}
      class={`native-dialog ${props.class ?? ""}`}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      onCancel={(event) => {
        event.preventDefault();
        props.cancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const targets = [...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]",
        )].filter((element) =>
          element.tabIndex >= 0 && !!element.getClientRects().length
        );
        const first = targets[0], last = targets.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      {props.children}
    </dialog>
  );
}
