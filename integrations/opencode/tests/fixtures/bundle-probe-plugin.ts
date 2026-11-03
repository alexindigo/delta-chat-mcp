// SPDX-License-Identifier: LGPL-3.0-only
// Test-owned injection port: exercises the actual generated bundle's registry
// and authenticated SDK adapter; does not implement future subscription hooks.
import type { Foundation, FoundationPorts } from "../../mod.ts";
import { object } from "../../types.ts";
import { z } from "zod";

export default async function probe(input: unknown, options: unknown) {
  const specifier =
    new URL("../../dist/delta-chat-mcp-opencode.js", import.meta.url).href;
  const module = object(await import(specifier));
  if (typeof module.default !== "function") {
    throw new Error("Missing real bundle");
  }
  const factory = module.default as (
    input: unknown,
    options: unknown,
    ports: FoundationPorts,
  ) => Promise<unknown>;
  return await factory(input, options, {
    attach(f: Foundation) {
      return {
        tool: {
          j2_foundation: {
            description: "J2 actual bundle registry/runtime contract",
            args: {
              action: { type: "string" },
              target: { type: "string" },
              messageID: { type: "string" },
              partID: { type: "string" },
              text: { type: "string" },
            },
            async execute(args: unknown, context: { sessionID: string }) {
              if (object(args).action === "preserve-selection") {
                const request = z.object({
                  target: z.string().min(1),
                  messageID: z.string().min(1),
                  partID: z.string().min(1),
                  text: z.string(),
                }).parse(args);
                const target = await f.opencode.session(request.target);
                if (!target) throw new Error("Fixture target missing");
                const selection = f.opencode.selection(target);
                await f.opencode.submit(request.target, {
                  ...request,
                  selection,
                  metadata: { j2SelectionProbe: true },
                });
                return JSON.stringify({
                  target: request.target,
                  messageID: request.messageID,
                  selection,
                });
              }
              const session = await f.opencode.session(context.sessionID);
              if (!session) throw new Error("Fixture session missing");
              const selection = f.opencode.selection(session);
              f.registry.write((tx) =>
                tx.putSubscription({
                  session_id: context.sessionID,
                  relay: "j2@example.invalid",
                  chat_id: 42,
                  directory: f.directory,
                  owner_server: f.owner,
                  alias: "fixture",
                  state: "active",
                  anchor_id: 10,
                  recent_ids: [10],
                  created_at: Date.now(),
                  updated_at: Date.now(),
                  left_at: null,
                })
              );
              const config = f.relays.get("fixture")?.config;
              const facts = {
                sessionID: context.sessionID,
                epoch: f.epoch,
                owner: f.owner,
                directory: f.directory,
                runtime: f.registry.runtime,
                directories: f.registry.directories(f.owner),
                selection,
                resolvedUrl: config?.url === process.env.DCMCP_TEST_MCP_URL,
                resolvedHeader: config?.headers.Authorization ===
                  `Bearer ${process.env.DCMCP_TEST_MCP_TOKEN}`,
              };
              return JSON.stringify(facts);
            },
          },
        },
      };
    },
  });
}
