// SPDX-License-Identifier: LGPL-3.0-only
import type { MessagingState } from "./messaging.ts";
import type { KeysState } from "./keys.ts";
import type { Screen } from "./location.ts";
export interface SetupProgress {
  next: Screen | null;
  complete: boolean;
  paired: boolean;
  steps: { label: string; href: string; done: boolean }[];
  label: string;
}
/** Observed core facts, never a second onboarding journal or authorization gate. */
export function setupProgress(
  state: MessagingState,
  keys: KeysState,
  publicMode: boolean,
): SetupProgress {
  const identity = state.account?.configured === true;
  const paired = state.contactsLoaded &&
    state.contacts.some((contact) =>
      contact.id > 9 && !contact.isBlocked && contact.isKeyContact &&
      contact.e2eeAvail &&
      state.chats.some((chat) =>
        !chat.isContactRequest && chat.contactIds.includes(contact.id)
      )
    );
  const key = publicMode || keys.rows.length > 0;
  const next: Screen | null = !state.account || state.account.core !== "ready"
    ? null
    : !identity
    ? "identity"
    : !state.contactsLoaded
    ? null
    : !paired
    ? "contacts"
    : !publicMode && !keys.loaded
    ? null
    : !key
    ? "keys"
    : "chats";
  return {
    next,
    paired,
    complete: identity && paired && key,
    steps: [
      { label: "Create identity", href: "/identity", done: identity },
      { label: "Connect chat", href: "/contacts", done: paired },
      ...(!publicMode
        ? [{ label: "API keys", href: "/keys", done: keys.rows.length > 0 }]
        : []),
    ],
    label: next === "identity"
      ? "Create identity"
      : next === "contacts"
      ? "Connect chat"
      : next === "keys"
      ? "Connect your agent"
      : next === "chats"
      ? "Open chats"
      : "Checking setup…",
  };
}
