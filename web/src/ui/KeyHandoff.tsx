// SPDX-License-Identifier: LGPL-3.0-only
import { onSettled, Show } from "solid-js";

/** Owns only its native modal DOM/focus. The caller owns the once-only value. */
export function KeyHandoff(props: {
  value: string;
  copying: boolean;
  copied: boolean;
  error: string;
  copy: () => void;
  acknowledge: () => void;
}) {
  let dialog!: HTMLDialogElement;
  onSettled(() => {
    dialog.showModal();
    return () => dialog.close();
  });
  return (
    <dialog
      ref={(element) => dialog = element}
      class="key-handoff"
      aria-labelledby="key-handoff-title"
      aria-describedby="key-handoff-help"
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = [
          ...dialog.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <h2 id="key-handoff-title">Save this API key</h2>
      <p id="key-handoff-help">
        Shown only once. Keep it for your agent's environment as{" "}
        <code>DELTA_CHAT_MCP_KEY</code>.
      </p>
      <code class="key-handoff-value" data-once-key>{props.value}</code>
      <div class="key-handoff-copy">
        <button
          type="button"
          autofocus
          data-action="copy-key"
          disabled={props.copying}
          onClick={() => props.copy()}
        >
          {props.copied ? "Key copied" : "Copy key"}
        </button>
        <span role="status" aria-live="polite">
          {props.copied ? "Key copied." : ""}
        </span>
      </div>
      <Show when={props.error}>
        <p class="error" role="alert">{props.error}</p>
      </Show>
      <p class="quiet">
        Copying keeps this step open until you've saved the key.
      </p>
      <button
        type="button"
        class="primary"
        data-action="dismiss-key"
        onClick={() => props.acknowledge()}
      >
        I've saved it
      </button>
    </dialog>
  );
}
