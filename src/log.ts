// SPDX-License-Identifier: LGPL-3.0-only
export type Level = "debug" | "info" | "warn" | "error";
export interface Log {
  event(level: Level, event: string, fields?: Record<string, unknown>): void;
  registerSecrets(values: readonly string[]): void;
}
const priorities: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const sensitive =
  /(?:password|passwd|passphrase|secret|token|authorization|cookie|key)(?:hash|value|data)?$|^(?:text|body|content|message|qr|svg)$/i;

/** Owned producers supply event names and metadata, never rendered exception/body text. */
export function createLog(
  level: string,
  initialSecrets: readonly string[] = [],
  sink: (line: string) => void = (line) => console.log(line),
): Log {
  const secrets = new Set<string>();
  const registerSecrets = (values: readonly string[]) => {
    for (const value of values) {
      if (value) {
        secrets.add(value);
        secrets.add(encodeURIComponent(value));
      }
    }
  };
  registerSecrets(initialSecrets);
  function redact(
    value: unknown,
    depth = 0,
    seen = new WeakSet<object>(),
  ): unknown {
    if (typeof value === "string") {
      let result = value;
      for (const secret of secrets) {
        result = result.replaceAll(secret, "[redacted]");
      }
      return result.slice(0, 4096);
    }
    if (
      value === null || typeof value === "number" || typeof value === "boolean"
    ) return value;
    if (value instanceof Error) return { name: value.name };
    if (typeof value !== "object") return "[omitted]";
    if (depth >= 6 || seen.has(value)) return "[omitted]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 64).map((item) => redact(item, depth + 1, seen));
    }
    const result: Record<string, unknown> = {};
    for (
      const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
      ).slice(0, 64)
    ) {
      result[key] = sensitive.test(key.replace(/[^a-z0-9]/gi, ""))
        ? "[redacted]"
        : "value" in descriptor
        ? redact(descriptor.value, depth + 1, seen)
        : "[omitted]";
    }
    return result;
  }
  return {
    registerSecrets,
    event(severity, event, fields = {}) {
      if (priorities[severity] < priorities[level as Level]) return;
      if (!/^[a-z][a-z0-9_]*$/.test(event)) {
        throw new Error(
          "Invalid log event name",
        );
      }
      sink(
        JSON.stringify({
          time: new Date().toISOString(),
          level: severity,
          event,
          fields: redact(fields),
        }),
      );
    },
  };
}
