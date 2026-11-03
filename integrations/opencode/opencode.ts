// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import {
  type ModelSelection,
  modelSelection,
  nativeMessage,
  object,
} from "./types.ts";

const sessionInfo = z.object({
  id: z.string().min(1),
  agent: z.string().optional(),
  model: z.object({
    id: z.string(),
    providerID: z.string(),
    variant: z.string().optional(),
  }).optional(),
  revert: z.unknown().optional(),
}).passthrough();
export type SessionInfo = z.infer<typeof sessionInfo>;
type Method = (input?: unknown) => Promise<unknown>;

/** Uses the supplied authenticated, directory-scoped legacy client exclusively.
 * Signatures: pinned sdk.gen.ts session.status/get/messages/message/promptAsync,
 * mcp.status and tui.showToast, proven by G0 C7/C9/C11/C17/C18/C23. */
export class OpenCode {
  constructor(
    private readonly client: unknown,
    private readonly lifetime?: AbortSignal,
  ) {
    object(client);
  }
  async #call(
    group: string,
    method: string,
    input?: unknown,
    missing = false,
    lookup = false,
  ) {
    const owner = object(object(this.client)[group]);
    if (typeof owner[method] !== "function") {
      throw new Error("Unsupported OpenCode client");
    }
    // Pinned sdk.gen.ts spreads options into RequestInit (client.gen.ts:66–86).
    // Bound every native request, including GETs used during shutdown.
    const signal = AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(this.lifetime ? [this.lifetime] : []),
    ]);
    const response = object(
      await (owner[method] as Method).call(owner, {
        ...(input === undefined ? {} : object(input)),
        signal,
      }),
    );
    const status = response.response instanceof Response
      ? response.response.status
      : undefined;
    if (missing && status === 404) {
      return lookup ? { exists: false } : undefined;
    }
    if (
      response.error !== undefined || (status !== undefined && status >= 400)
    ) {
      throw new Error("OpenCode request failed");
    }
    return lookup ? { exists: true, value: response.data } : response.data;
  }
  async session(id: string): Promise<SessionInfo | undefined> {
    const data = await this.#call("session", "get", { path: { id } }, true);
    return data === undefined ? undefined : sessionInfo.parse(data);
  }
  async status() {
    return z.record(
      z.string(),
      z.object({ type: z.enum(["idle", "busy", "retry"]) }).passthrough(),
    ).parse(await this.#call("session", "status"));
  }
  async mcpStatus() {
    return z.record(z.string(), z.object({ status: z.string() }).passthrough())
      .parse(await this.#call("mcp", "status"));
  }
  async aliasEnabled(alias: string): Promise<boolean> {
    // Absence is not permission to bypass the native catalog.
    const state = (await this.mcpStatus())[alias];
    return state !== undefined && state.status !== "disabled";
  }
  async messages(id: string) {
    return z.array(nativeMessage).parse(
      await this.#call("session", "messages", { path: { id } }),
    );
  }
  async message(id: string, messageID: string) {
    const result = await this.lookupMessage(id, messageID);
    if (!result.exists) return undefined;
    if (!result.message) throw new Error("Unreadable native message");
    return result.message;
  }
  async lookupMessage(id: string, messageID: string) {
    const result = object(
      await this.#call(
        "session",
        "message",
        {
          path: { id, messageID },
        },
        true,
        true,
      ),
    );
    if (result.exists === false) return { exists: false as const };
    const parsed = nativeMessage.safeParse(result.value);
    return {
      exists: true as const,
      message: parsed.success ? parsed.data : undefined,
    };
  }
  selection(
    info: SessionInfo,
    latest?: z.infer<typeof nativeMessage>,
  ): ModelSelection {
    const chosen = info.model
      ? {
        providerID: info.model.providerID,
        modelID: info.model.id,
        variant: info.model.variant,
      }
      : latest?.info.model;
    return modelSelection.parse({
      agent: info.agent ?? latest?.info.agent,
      model: chosen,
      // C7b on both pins: omission inherits the agent's configured variant;
      // the characterized explicit default preserves the native selection.
      variant: chosen?.variant ?? "default",
    });
  }
  async submit(id: string, input: {
    messageID: string;
    partID: string;
    text: string;
    metadata: Record<string, unknown>;
    selection: ModelSelection;
    noReply?: boolean;
  }) {
    const selection = modelSelection.parse(input.selection);
    z.string().startsWith("msg_").parse(input.messageID);
    z.string().startsWith("prt_").parse(input.partID);
    await this.#call("session", "promptAsync", {
      path: { id },
      body: {
        ...selection,
        messageID: input.messageID,
        ...(input.noReply ? { noReply: true } : {}),
        parts: [{
          id: input.partID,
          type: "text",
          text: z.string().parse(input.text),
          metadata: input.metadata,
        }],
      },
    });
  }
  async toast(message: string): Promise<void> {
    try {
      await this.#call("tui", "showToast", {
        body: { message, variant: "warning" },
      });
    } catch {
      /* Best effort headless UI; durable health belongs to registry. */
    }
  }
}
