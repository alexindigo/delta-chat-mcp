// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { Invite } from "../messaging-types.ts";
export function InvitePanel(
  props: { invite: Invite | null; qrUrl: string; copy: () => void },
) {
  return (
    <section class="invite-panel" aria-label="Pair a contact">
      <h2>Pair your phone</h2>
      <p>
        Scan this invitation with Delta Chat, or copy the link to your contact.
      </p>
      <Show
        when={props.invite}
        fallback={<p role="status">Loading invitation…</p>}
      >
        <div class="invite-layout">
          <div class="invite-qr">
            <img
              data-invite-qr
              src={props.qrUrl}
              width="220"
              height="220"
              alt="Delta Chat contact invitation"
            />
          </div>
          <div class="invite-link">
            <label for="own-invite">Your invitation</label>
            <textarea
              id="own-invite"
              readonly
              value={props.invite?.link ?? ""}
              rows={4}
            />
            <button
              type="button"
              data-action="copy-invite"
              onClick={() => props.copy()}
            >
              Copy invitation
            </button>
          </div>
        </div>
      </Show>
    </section>
  );
}
