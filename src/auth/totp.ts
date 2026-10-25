// SPDX-License-Identifier: LGPL-3.0-only
import { authenticator } from "otplib";

/** otplib's native RFC4648 Base32 secret is shared with standard authenticator apps. */
export function enrollment(username: string) {
  const key = authenticator.generateSecret(20);
  return {
    key,
    uri: authenticator.keyuri(
      username || "delta-chat-mcp",
      "delta-chat-mcp",
      key,
    ),
  };
}
export function acceptedStep(
  code: string,
  key: string,
  now: number,
): number | null {
  if (!/^\d{6}$/.test(code) || !/^[A-Z2-7]+$/.test(key)) return null;
  const otp = authenticator.clone();
  otp.options = { epoch: now, window: 1, digits: 6, step: 30 };
  const delta = otp.checkDelta(code, key);
  return delta === null ? null : Math.floor(now / 30000) + delta;
}
