// SPDX-License-Identifier: LGPL-3.0-only
import type { ServiceBag } from "../service.ts";
import { toolResult } from "./result.ts";

export interface SessionContext {
  mcpReq: { _meta?: Record<string, unknown> };
}
export function sessionID(ctx: SessionContext, input: { session_id?: string }) {
  const native = ctx.mcpReq._meta?.["ai.opencode/sessionID"];
  return typeof native === "string" && native.length
    ? native
    : input.session_id;
}
export function agentResult(
  services: ServiceBag,
  ctx: SessionContext,
  input: { session_id?: string; chat_id?: number },
  action: () => Promise<Record<string, unknown>>,
) {
  return toolResult(async () => {
    services.routing?.interest(
      services.mcpOwner ?? "public",
      sessionID(ctx, input),
      input.chat_id,
    );
    return await action();
  });
}
