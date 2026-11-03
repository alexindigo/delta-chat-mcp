// SPDX-License-Identifier: LGPL-3.0-only
import {
  parseOptions as stateOptions,
  type RelayConfiguration,
  sanitizedAlias,
} from "./options.ts";
import { z } from "zod";

const relay = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean(),
}).strict();
const schema = z.object({
  relays: z.record(z.string().min(1), relay),
  stateFile: z.string().optional(),
}).strict();
export function parsePluginOptions(input: unknown) {
  const parsed = schema.parse(input);
  const names = Object.keys(parsed.relays);
  const base = stateOptions({
    servers: names.length ? names : ["unused"],
    stateFile: parsed.stateFile,
  });
  const relays: RelayConfiguration[] = names.map((alias) => {
    const value = parsed.relays[alias];
    const url = new URL(value.url);
    if (
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password ||
      [value.url, ...Object.values(value.headers)].some((s) =>
        /\{(?:env|file):/.test(s)
      ) || names.some((other) =>
        other !== alias && sanitizedAlias(other) === sanitizedAlias(alias)
      )
    ) {
      throw new Error("Invalid or unresolved plugin relay configuration");
    }
    return { alias, ...value };
  });
  return { ...base, servers: names, relays };
}
export type PluginOptions = ReturnType<typeof parsePluginOptions>;
