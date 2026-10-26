// SPDX-License-Identifier: LGPL-3.0-only
import type { App, Handler } from "@pathfinder/pathfinder";
import { z } from "zod";
import { CoreUnavailable } from "../core/client.ts";
import { IdentityRequired } from "../messaging/account.ts";
import { UnknownMessageAnchor } from "../messaging/chats.ts";
import { MessageLoadError } from "../messaging/load.ts";
import { AttachmentError } from "../messaging/attachments.ts";

export const id = z.coerce.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
);
export const ids = z.array(id).max(1000);
export async function input<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InputError();
  }
  return parse(schema, value);
}
export class InputError extends Error {}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InputError();
  return parsed.data;
}
export function messagingRoute(
  action: (
    request: Request,
    app: App,
    params: Record<string, unknown>,
  ) => Promise<unknown>,
): Handler {
  return async (request, { app }) => {
    try {
      const value = await action(request._raw, app, request.params);
      return value instanceof Response
        ? value
        : Response.json(value, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      let status = 400,
        message = "Messaging request failed. Check the input and retry.";
      if (error instanceof InputError) message = "Invalid messaging input";
      else if (error instanceof CoreUnavailable) {
        status = 503;
        message = "Core restarting. Retry when ready.";
      } else if (error instanceof MessageLoadError) {
        status = 503;
        message = "Unable to load message. Retry when ready.";
      } else if (error instanceof AttachmentError) {
        status = error.status;
        message = error.message;
      } else if (error instanceof IdentityRequired) {
        status = 409;
        message = "Configure the relay identity first.";
      } else if (error instanceof UnknownMessageAnchor) {
        status = 409;
        message = "History changed. Refresh this conversation.";
      }
      app.log.event("warn", "messaging_request_failed", {
        name: error instanceof Error ? error.name : typeof error,
      });
      return Response.json({ error: message }, {
        status,
        headers: { "cache-control": "no-store" },
      });
    }
  };
}
