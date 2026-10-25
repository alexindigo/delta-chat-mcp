// SPDX-License-Identifier: LGPL-3.0-only
import type { Account } from "./messaging-types.ts";
export function identityName(account: Account | null) {
  if (account?.displayName) return account.displayName;
  if (account?.configured) return "Unavailable while core restarts";
  return account?.core === "ready" ? "Not configured" : "Unknown";
}
export function connectivity(account: Account | null, stream: boolean) {
  if (!stream) return "Relay connection interrupted. Reconnecting…";
  if (!account) return "Checking core…";
  if (account.core !== "ready") return "Core restarting…";
  if (!account.configured) return "Identity not configured";
  // Selected core's getConnectivity scale; HTTP success is not network ready.
  if ((account.connectivity ?? 0) >= 4000) return "Connected to chatmail";
  if ((account.connectivity ?? 0) >= 3000) return "Updating chatmail…";
  if ((account.connectivity ?? 0) >= 2000) return "Connecting to chatmail…";
  if ((account.connectivity ?? 0) >= 1000) return "Not connected to chatmail";
  return `Chatmail connectivity: ${account.connectivity ?? "unknown"}`;
}
