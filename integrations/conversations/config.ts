// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute } from "node:path";
import { env } from "node:process";
import { z } from "zod";
import type { RelayConfiguration } from "../opencode/options.ts";

const header = z.union([
  z.string(),
  z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
]);
const options = z.object({
  stateFile: z.string().refine(isAbsolute),
  relays: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    z.object({
      url: z.string().url(),
      enabled: z.boolean(),
      headers: z.record(z.string(), header),
    }).strict(),
  ),
}).strict();

/** Explicit plugin configuration, separate from a native remote MCP entry.
 * Secret references resolve at this boundary only, never into durable state. */
export function configuration(
  value: unknown,
  environment: Record<string, string | undefined> = env,
): {
  stateFile: string;
  relays: RelayConfiguration[];
} {
  const parsed = options.parse(value);
  return {
    stateFile: parsed.stateFile,
    relays: Object.entries(parsed.relays).map(([alias, item]) => {
      const url = new URL(item.url);
      if (
        !["http:", "https:"].includes(url.protocol) || url.username ||
        url.password || /\{(?:env|file):/.test(item.url)
      ) {
        throw new Error("Invalid relay endpoint");
      }
      return {
        alias,
        url: item.url,
        enabled: item.enabled,
        headers: Object.fromEntries(
          Object.entries(item.headers).map(([key, reference]) => {
            const value = typeof reference === "string"
              ? reference
              : environment[reference.env];
            if (
              value === undefined || /\{(?:env|file):/.test(value)
            ) throw new Error("Unresolved relay header");
            return [key, value];
          }),
        ),
      };
    }),
  };
}
