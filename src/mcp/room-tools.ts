// SPDX-License-Identifier: LGPL-3.0-only
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../service.ts";
import { inboxUri } from "../messaging/room-routing.ts";
import { type SessionContext, sessionID } from "./agent.ts";
import { toolResult } from "./result.ts";

export function roomTools(
  server: McpServer,
  services: ServiceBag,
  subscriptions = false,
) {
  const routing = services.routing;
  if (!routing) return;
  const owner = services.mcpOwner ?? "public";
  const uri = inboxUri(routing.namespace(owner));
  if (subscriptions) {
    server.server.registerCapabilities({ resources: { subscribe: true } });
  }
  server.registerResource("room-inbox", uri, {
    mimeType: "application/json",
    description: "Authenticated metadata-only room delivery inbox.",
  }, () => ({
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(routing.inbox(owner)),
    }],
  }));
  // Claimed bodies are transient core reads, separate from metadata inbox state.
  server.registerResource(
    "room-delivery",
    new ResourceTemplate(`${uri}/delivery/{id}/{token}`, { list: undefined }),
    { mimeType: "application/json" },
    async (url, variables) => {
      const data = await routing.bodies(
        owner,
        String(variables.id),
        String(variables.token),
      );
      return {
        contents: [{
          uri: url.href,
          mimeType: "application/json",
          text: JSON.stringify(data),
        }],
      };
    },
  );
  const session = (ctx: SessionContext, input: { session_id?: string }) => {
    const id = sessionID(ctx, input);
    if (!id) throw new Error("Native session metadata or session_id required");
    return id;
  };
  const room = z.object({
    chat_id: z.number().int().positive(),
    session_id: z.string().min(1).optional(),
  });
  server.registerTool(
    "room_subscribe",
    {
      description:
        "Subscribe/rejoin this session to a room and become its latest recipient.",
      inputSchema: room,
    },
    (args, ctx) =>
      toolResult(() =>
        routing.subscribe(owner, session(ctx, args), args.chat_id)
      ),
  );
  server.registerTool("room_subscriptions", {
    description:
      "List this session's persistent subscriptions and current recipient/discontinuity facts.",
    inputSchema: z.object({ session_id: z.string().min(1).optional() }),
  }, (args, ctx) =>
    toolResult(() => {
      const id = session(ctx, args);
      routing.interest(owner, id);
      return routing.subscriptions(owner, id);
    }));
  server.registerTool(
    "room_leave",
    {
      description:
        "Leave this session's subscription, keeping shared room/history and claimed work.",
      inputSchema: room,
    },
    (args, ctx) =>
      toolResult(() => routing.leave(owner, session(ctx, args), args.chat_id)),
  );
  server.registerTool(
    "room_resume",
    {
      description:
        "Explicitly resume a blocked room after a chosen existing core message. Earlier messages are not replayed.",
      inputSchema: room.extend({ after_id: z.number().int().positive() }),
    },
    (args, ctx) =>
      toolResult(() =>
        routing.resume(owner, session(ctx, args), args.chat_id, args.after_id)
      ),
  );
  const delivery = z.object({ delivery_id: z.string().uuid() });
  const claimed = delivery.extend({ claim_token: z.string().uuid() });
  server.registerTool("inbox_claim", {
    description:
      "Integration-only atomic frozen-batch claim. Retry with the same durable claimant.",
    inputSchema: delivery.extend({ claimant: z.string().uuid() }),
  }, (args, ctx) =>
    toolResult(() => ({
      ...routing.claim(
        owner,
        args.delivery_id,
        args.claimant,
        sessionID(ctx, {}),
      ),
    })));
  server.registerTool("inbox_complete", {
    description:
      "Integration-only idempotent terminal outcome; never refreshes room interest.",
    inputSchema: claimed.extend({
      outcome: z.enum([
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
      ]),
    }),
  }, (args) =>
    toolResult(() => ({
      ...routing.complete(
        owner,
        args.delivery_id,
        args.claim_token,
        args.outcome,
      ),
    })));
  server.registerTool(
    "inbox_release",
    {
      description:
        "Trusted integration only: release a claim only with proof that native dispatch never occurred.",
      inputSchema: claimed,
    },
    (args) =>
      toolResult(() =>
        routing.release(owner, args.delivery_id, args.claim_token)
      ),
  );
  server.registerTool(
    "inbox_mirror",
    {
      description:
        "Integration-only final mirror to the claimed room. Unknown core result is uncertain and is never resent.",
      inputSchema: claimed.extend({ text: z.string().min(1) }),
    },
    (args) =>
      toolResult(() =>
        routing.mirror(owner, args.delivery_id, args.claim_token, args.text)
      ),
  );
}
