// SPDX-License-Identifier: LGPL-3.0-only
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { env } from "node:process";
import { z } from "zod";
import { object } from "./types.ts";

const schema = z.object({
  servers: z.array(z.string().min(1)).min(1),
  stateFile: z.string().refine(isAbsolute).optional(),
  waitSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(
    300,
  ),
}).strict();
export interface Options {
  servers: string[];
  stateFile: string;
  waitSeconds: number;
}
export function parseOptions(value: unknown): Options {
  const parsed = schema.parse(value);
  return {
    ...parsed,
    servers: [...new Set(parsed.servers)],
    stateFile: parsed.stateFile ?? join(
      env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local/state"),
      "delta-chat-mcp/opencode-wake.sqlite",
    ),
  };
}
export interface RelayConfiguration {
  alias: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
}
// Matches the pinned OpenCode mcp/catalog.ts tool-name boundary exactly.
export const sanitizedAlias = (alias: string) =>
  alias.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Configuration failures belong to one alias, never to the whole instance. */
export function resolveServerRoutes(config: unknown, options: Options) {
  const servers: RelayConfiguration[] = [];
  const unroutable = new Set<string>();
  for (const alias of options.servers) {
    if (
      options.servers.some((other) =>
        other !== alias && sanitizedAlias(other) === sanitizedAlias(alias)
      )
    ) {
      unroutable.add(alias);
      continue;
    }
    try {
      servers.push(...resolveServers(config, { ...options, servers: [alias] }));
    } catch {
      unroutable.add(alias);
    }
  }
  return { servers, unroutable };
}
/** Only resolved OpenCode config is accepted; credentials never have another source. */
export function resolveServers(
  config: unknown,
  options: Options,
): RelayConfiguration[] {
  const entries = object(object(config).mcp);
  return options.servers.map((alias) => {
    const server = object(entries[alias]);
    const parsed = z.object({
      type: z.literal("remote"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).default({}),
      enabled: z.boolean().default(true),
    }).parse(server);
    const url = new URL(parsed.url);
    if (
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password
    ) {
      throw new Error("Invalid relay endpoint");
    }
    if (
      [parsed.url, ...Object.values(parsed.headers)].some((v) =>
        /\{(?:env|file):/.test(v)
      )
    ) {
      throw new Error("Relay configuration is unresolved");
    }
    return {
      alias,
      url: parsed.url,
      headers: parsed.headers,
      enabled: parsed.enabled,
    };
  });
}
