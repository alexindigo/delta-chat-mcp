// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";

export const positiveID = z.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
);
export const routingKey = z.object({
  session_id: z.string().min(1),
  relay: z.string().min(1),
  chat_id: positiveID,
});
export type RoutingKey = z.infer<typeof routingKey>;
export const subscriptionState = z.enum([
  "active",
  "left",
  "orphaned",
  "unroutable",
  "paused",
  "blocked_discontinuity",
]);

// Single terminal-state authority: registry constraints, transitions, retention
// and keeper view all consume this list, including inherited failure outcomes.
export const terminalDeliveryStates = [
  "mirrored",
  "mirror_uncertain",
  "answered_by_model",
  "empty",
  "aborted",
  "failed",
  "superseded_by_native_input",
  "interrupted_unanswered",
  "source_deleted",
  "cancelled",
  "stalled",
  "mirror_failed",
] as const;
export const deliveryState = z.enum([
  "open",
  "submitting",
  "submitted",
  "admission_failed",
  "admitted",
  "mirroring",
  ...terminalDeliveryStates,
]);
export type DeliveryState = z.infer<typeof deliveryState>;
export const isTerminalDelivery = (state: DeliveryState) =>
  (terminalDeliveryStates as readonly string[]).includes(state);
export function validDeliveryTransition(
  from: DeliveryState,
  to: DeliveryState,
): boolean {
  if (isTerminalDelivery(from)) return false;
  if (from === to) return true;
  const edges: Record<
    Exclude<DeliveryState, typeof terminalDeliveryStates[number]>,
    readonly DeliveryState[]
  > = {
    open: ["submitting", "cancelled", "source_deleted", "failed"],
    submitting: [
      "submitted",
      "admitted",
      "admission_failed",
      "failed",
      "cancelled",
      "source_deleted",
      "superseded_by_native_input",
    ],
    submitted: [
      "submitting",
      "admitted",
      "admission_failed",
      "failed",
      "cancelled",
      "source_deleted",
      "superseded_by_native_input",
    ],
    admission_failed: [
      "submitting",
      "admitted",
      "failed",
      "cancelled",
      "source_deleted",
      "superseded_by_native_input",
    ],
    admitted: [
      "submitting",
      "mirroring",
      "answered_by_model",
      // A real model tool attempt may already have posted the exact final.
      "mirror_uncertain",
      "empty",
      "aborted",
      "failed",
      "superseded_by_native_input",
      "interrupted_unanswered",
      "stalled",
      "source_deleted",
    ],
    // Returning to admitted is reserved for a proven no-dispatch rejection.
    mirroring: ["admitted", "mirrored", "mirror_uncertain", "mirror_failed"],
  };
  return edges[from as keyof typeof edges].includes(to);
}
export const idList = z.array(positiveID).refine((ids) =>
  new Set(ids).size === ids.length
);
export const subscription = routingKey.extend({
  directory: z.string().startsWith("/"),
  owner_server: z.string().url(),
  alias: z.string().min(1),
  state: subscriptionState,
  anchor_id: positiveID,
  recent_ids: idList.max(32),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  left_at: z.number().int().nonnegative().nullable(),
});
export type Subscription = z.infer<typeof subscription>;
export const relayScope = z.object({
  identity: z.string().min(1),
  uri: z.string().url().refine((value) => {
    const u = new URL(value);
    return u.protocol === "deltachat:" && u.hostname === "inbox" &&
      u.pathname.length > 1 && !u.username && !u.password && !u.search &&
      !u.hash;
  }),
}).strict();
export type RelayScope = z.infer<typeof relayScope>;
export const deliveryEdge = relayScope.extend({ alias: z.string().min(1) });
export type DeliveryEdge = z.infer<typeof deliveryEdge>;
export function sameRelayScope(a: RelayScope, b: RelayScope): boolean {
  return a.identity === b.identity && a.uri === b.uri;
}
export const delivery = routingKey.extend({
  id: z.string().uuid(),
  from_anchor: positiveID,
  message_ids: idList.min(1),
  state: deliveryState,
  user_message_id: z.string().startsWith("msg_").nullable(),
  attempts: z.number().int().min(0).max(3),
  continuations: z.number().int().min(0).max(2),
  model_sent_ids: idList,
  mirror_message_ids: idList,
  superseding_message_id: z.string().startsWith("msg_").nullable(),
  // Codes only: never raw errors, room content, or assistant text.
  reason: z.enum([
    "prompt_error",
    "model_error",
    "transport_uncertain",
    "source_deleted",
    "native_input",
    "interrupted",
    "attempts_exhausted",
    "continuations_exhausted",
    "left",
    "relay_error",
  ]).nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  completed_at: z.number().int().nonnegative().nullable(),
});
export type Delivery = z.infer<typeof delivery>;
export const submission = z.object({
  delivery_id: z.string().uuid(),
  ordinal: z.number().int().min(0).max(2),
  kind: z.enum(["initial", "continuation"]),
  message_id: z.string().regex(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
  part_id: z.string().regex(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
  submit_epoch: z.string().uuid(),
  attempts: z.number().int().min(1).max(3),
  state: z.enum([
    "submitting",
    "submitted",
    "admitted",
    "admission_failed",
    "failed",
  ]),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type Submission = z.infer<typeof submission>;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid OpenCode object");
  }
  return value as Record<string, unknown>;
}

export const modelSelection = z.object({
  agent: z.string().min(1),
  model: z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
  }),
  variant: z.string().optional(),
});
export type ModelSelection = z.infer<typeof modelSelection>;
export const nativePart = z.object({
  id: z.string().min(1),
  type: z.string(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export const nativeMessage = z.object({
  info: z.object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    parentID: z.string().optional(),
    agent: z.string().optional(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
      variant: z.string().optional(),
    }).optional(),
    finish: z.string().optional(),
    error: z.object({ name: z.string() }).passthrough().optional(),
    time: z.object({ created: z.number(), completed: z.number().optional() }),
  }).passthrough(),
  parts: z.array(nativePart),
});
export type NativeMessage = z.infer<typeof nativeMessage>;

export const relayMessage = z.object({
  id: positiveID,
  chatId: positiveID,
  fromContactId: positiveID,
  fromSelf: z.boolean(),
  fromName: z.string(),
  fromAddress: z.string(),
  isInfo: z.boolean(),
  isBot: z.boolean(),
  isForwarded: z.boolean(),
  text: z.string(),
  textComplete: z.boolean(),
  html: z.string().optional(),
  timestamp: z.number(),
  state: z.string(),
  hasAttachment: z.boolean(),
  attachmentName: z.string().optional(),
  quote: z.object({
    text: z.string(),
    messageId: positiveID.optional(),
    authorName: z.string().optional(),
  }).optional(),
}).passthrough();
export type RelayMessage = z.infer<typeof relayMessage>;
