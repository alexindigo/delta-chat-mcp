// SPDX-License-Identifier: LGPL-3.0-only
import { loadConfig } from "../src/config.ts";

/** Packaging admission uses the application's configured listener, not logs. */
export function healthUrl(listen: { hostname: string; port: number }) {
  if (!listen.port) {
    throw new Error("A stable nonzero service port is required");
  }
  const hostname = listen.hostname === "0.0.0.0"
    ? "127.0.0.1"
    : listen.hostname === "::"
    ? "::1"
    : listen.hostname;
  return `http://${
    hostname.includes(":") ? `[${hostname}]` : hostname
  }:${listen.port}/_/health`;
}

export async function waitReady(url: string, budget = 40000) {
  const until = Date.now() + budget;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.ok === true && health.core === "ready") return;
    } catch { /* listener/core may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Service did not become ready within deployment deadline");
}

if (import.meta.main) await waitReady(healthUrl(loadConfig().listen));
