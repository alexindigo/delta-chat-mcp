// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { setupProgress } from "../../web/src/onboarding.ts";
import { initialMessaging } from "../../web/src/messaging.ts";
import { initialKeys } from "../../web/src/keys.ts";
Deno.test("default guidance waits for core facts, uses accepted encrypted pairing and preserves existing keys/public mode", () => {
  const state = initialMessaging(), keys = initialKeys();
  const next = () => setupProgress(state, keys, false).next;
  assertEquals(next(), null);
  state.account = {
    configured: false,
    core: "restarting",
    accountId: null,
    address: null,
    displayName: null,
    connectivity: null,
  };
  assertEquals(next(), null);
  state.account.core = "ready";
  assertEquals(next(), "identity");
  state.account.configured = true;
  assertEquals(next(), null);
  state.contactsLoaded = true;
  assertEquals(next(), "contacts");
  state.contacts = [{
    id: 10,
    displayName: "Peer",
    address: "peer@test",
    isBlocked: false,
    isKeyContact: true,
    e2eeAvail: true,
  }];
  state.chats = [{
    id: 10,
    name: "Peer",
    type: "Single",
    isEncrypted: true,
    isContactRequest: true,
    freshMessageCount: 0,
    lastMessageId: null,
    lastMessageTime: null,
    contactIds: [10],
    summary: "",
  }];
  assertEquals(next(), "contacts");
  state.chats[0].isContactRequest = false;
  assertEquals(next(), null);
  keys.loaded = true;
  assertEquals(next(), "keys");
  assertEquals(setupProgress(state, keys, true).next, "chats");
  keys.rows = [{
    id: "existing",
    name: "Old agent",
    created: 1,
    lastUsed: null,
    createdText: "",
    lastUsedText: "Never",
  }];
  assertEquals(next(), "chats");
  state.contacts[0].isBlocked = true;
  assertEquals(next(), "contacts");
  assertEquals(keys.rows[0].id, "existing");
});
