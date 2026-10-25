// SPDX-License-Identifier: LGPL-3.0-only
import { parse } from "@std/toml";

export interface Config {
  listen: { hostname: string; port: number };
  data: { dir: string };
  mcp: { waitMaxSeconds: number };
  log: { level: string };
  auth: {
    type: string;
    username: string;
    password: string;
    totpkey: string;
    secretkey: string;
    sessionexpirydays: number;
  };
}
type Tree = { [key: string]: unknown };
type Schema = { [key: string]: "string" | "integer" | Schema };
const schema: Schema = {
  listen: { hostname: "string", port: "integer" },
  data: { dir: "string" },
  mcp: { waitMaxSeconds: "integer" },
  log: { level: "string" },
  auth: {
    type: "string",
    username: "string",
    password: "string",
    totpkey: "string",
    secretkey: "string",
    sessionexpirydays: "integer",
  },
};
const object = (v: unknown): v is Tree =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export const envName = (path: string) =>
  `DCMCP_${path.replaceAll(".", "_").toUpperCase()}`;
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration errors:\n${problems.join("\n")}`);
  }
}

/** Explicit inputs keep tests independent of the process environment. */
export function loadConfig(options: {
  env?: Record<string, string>;
  defaultsPath?: string | URL;
  authState?: Tree;
} = {}): Config {
  const env = options.env ?? Deno.env.toObject();
  const result: Tree = {};
  const errors: string[] = [];
  const leaves = new Map<string, { path: string; type: string }>();
  const problem = (path: string, text: string) =>
    errors.push(`${path} (${envName(path)}): ${text}`);
  function merge(
    input: Tree,
    shape: Schema,
    target: Tree,
    prefix: string,
    required: boolean,
  ) {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(shape, key)) problem(prefix + key, "unknown node");
    }
    for (const [key, type] of Object.entries(shape)) {
      const path = prefix + key;
      if (typeof type === "string") leaves.set(envName(path), { path, type });
      const value = input[key];
      if (value === undefined) {
        if (required) problem(path, "missing leaf or section in defaults");
        // Walk missing sections too, so defaults report every missing leaf.
        if (typeof type !== "string") {
          const child = object(target[key]) ? target[key] : {};
          target[key] = child;
          merge({}, type, child, path + ".", required);
        }
      } else if (typeof type === "string") {
        if (
          type === "string"
            ? typeof value !== "string"
            : !Number.isSafeInteger(value)
        ) {
          problem(path, `expected ${type}`);
        } else target[key] = value;
      } else if (!object(value)) problem(path, "expected section");
      else {
        const child = object(target[key]) ? target[key] : {};
        target[key] = child;
        merge(value, type, child, path + ".", required);
      }
    }
  }
  function file(path: string | URL): Tree {
    try {
      return parse(Deno.readTextFileSync(path));
    } catch {
      errors.push(`config file ${String(path)}: unreadable or malformed TOML`);
      return {};
    }
  }
  merge(
    file(
      options.defaultsPath ??
        new URL("../defaults/config.toml", import.meta.url),
    ),
    schema,
    result,
    "",
    true,
  );
  if (options.authState) {
    merge({ auth: options.authState }, schema, result, "", false);
  }
  if (env.DCMCP_CONFIG !== undefined) {
    merge(file(env.DCMCP_CONFIG), schema, result, "", false);
  }
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("DCMCP_") || name === "DCMCP_CONFIG") continue;
    const leaf = leaves.get(name);
    if (!leaf) {
      errors.push(`${name}: unknown node or section`);
      continue;
    }
    const value = leaf.type === "string"
      ? raw
      : /^-?\d+$/.test(raw)
      ? Number(raw)
      : NaN;
    if (leaf.type !== "string" && !Number.isSafeInteger(value)) {
      problem(leaf.path, "expected integer");
      continue;
    }
    const parts = leaf.path.split(".");
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] as Tree;
    target[parts.at(-1)!] = value;
  }
  const cfg = result as unknown as Config;
  if (!errors.length) {
    if (!cfg.listen.hostname) problem("listen.hostname", "must not be empty");
    if (cfg.listen.port < 0 || cfg.listen.port > 65535) {
      problem("listen.port", "expected 0..65535");
    }
    if (!cfg.data.dir) problem("data.dir", "must not be empty");
    if (cfg.mcp.waitMaxSeconds < 1 || cfg.mcp.waitMaxSeconds > 86400) {
      problem("mcp.waitMaxSeconds", "expected 1..86400");
    }
    if (!["debug", "info", "warn", "error"].includes(cfg.log.level)) {
      problem("log.level", "invalid level");
    }
    if (!["", "public", "password", "totp"].includes(cfg.auth.type)) {
      problem("auth.type", "invalid access level");
    }
    if (cfg.auth.sessionexpirydays < 1 || cfg.auth.sessionexpirydays > 365) {
      problem("auth.sessionexpirydays", "expected 1..365");
    }
  }
  if (errors.length) throw new ConfigError(errors);
  return cfg;
}
