// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { wakePrompt } from "../../integrations/opencode/wake-prompt.ts";
import { humanMessage } from "../../integrations/opencode/watcher.ts";
import type {
  RelayMessage,
  Subscription,
} from "../../integrations/opencode/types.ts";

const source: RelayMessage = {
  id: 41,
  chatId: 42,
  fromContactId: 12,
  fromSelf: false,
  fromName: "Operator",
  fromAddress: "operator@example.invalid",
  isInfo: false,
  isBot: false,
  isForwarded: false,
  text: "available display text",
  textComplete: false,
  timestamp: 1,
  state: "fresh",
  hasAttachment: true,
  attachmentName: "not-downloaded.bin",
  attachmentDownloadState: "Available",
};
const subscription: Subscription = {
  session_id: "session",
  relay: "relay@example.invalid",
  chat_id: 42,
  directory: "/A",
  owner_server: "http://localhost:4097/",
  alias: "relay",
  state: "active",
  anchor_id: 40,
  recent_ids: [40],
  created_at: 1,
  updated_at: 1,
  left_at: null,
};

Deno.test("J4 prompt preserves incomplete-download facts and never fabricates a complete body or downgrades the canonical sender", () => {
  const prompt = wakePrompt(subscription, "Room", [source]);
  assertStringIncludes(prompt, "Operator <operator@example.invalid>");
  assertStringIncludes(prompt, 'downloadState="Available"');
  assertStringIncludes(prompt, "textComplete=false; completeHTML=false");
  assertStringIncludes(prompt, "not a complete-body claim");
  assertStringIncludes(prompt, source.text);
  assertStringIncludes(prompt, source.attachmentName!);
  assert(!prompt.includes("not an instruction from the OpenCode operator"));
  const html = wakePrompt(subscription, "Room", [{
    ...source,
    html: "<table>entire HTML</table>",
  }]);
  assertStringIncludes(html, "completeHTML=true");
  assertStringIncludes(html, "<table>entire HTML</table>");
});

Deno.test("J4 human filter excludes SELF,special,info and bot for all history paths", () => {
  assertEquals(humanMessage(source), true);
  for (
    const message of [
      { ...source, fromSelf: true },
      { ...source, fromContactId: 9 },
      { ...source, isInfo: true },
      { ...source, isBot: true },
    ]
  ) assertEquals(humanMessage(message), false);
});
