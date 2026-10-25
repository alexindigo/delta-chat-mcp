// SPDX-License-Identifier: LGPL-3.0-only
import type { App, Handler } from "@pathfinder/pathfinder";
import { AuthError } from "../auth/state.ts";

export function authRoute(
  action: (request: Request, app: App) => Promise<Response>,
): Handler {
  return async (request, context) => {
    try {
      return await action(request._raw, context.app);
    } catch (error) {
      if (error instanceof AuthError) {
        return Response.json({ error: error.message }, {
          status: error.status,
        });
      }
      context.app.log.event("error", "auth_request_failed", {
        name: error instanceof Error ? error.name : typeof error,
      });
      return Response.json({ error: "Access request failed" }, { status: 500 });
    }
  };
}
export async function authInput(
  request: Request,
  allowed: readonly string[],
): Promise<Record<string, string>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new AuthError(400, "Invalid JSON input");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError(400, "Object input required");
  }
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!allowed.includes(key) || typeof field !== "string") {
      throw new AuthError(400, "Invalid input field");
    }
    result[key] = field;
  }
  return result;
}
