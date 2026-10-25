// SPDX-License-Identifier: LGPL-3.0-only
const encoder = new TextEncoder();
export const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}
async function derive(
  password: string,
  salt: Uint8Array,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: 100000,
      salt: salt as BufferSource,
    },
    key,
    256,
  );
}
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$100000$${hex(salt)}$${
    hex(await derive(password, salt))
  }`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const match = /^pbkdf2_sha256\$100000\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(
    stored,
  );
  if (!match) return false;
  const salt = new Uint8Array(
    match[1].match(/../g)!.map((byte) => parseInt(byte, 16)),
  );
  return timingSafeEqual(hex(await derive(password, salt)), match[2]);
}
