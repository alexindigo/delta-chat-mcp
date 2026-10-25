// SPDX-License-Identifier: LGPL-3.0-only
import { jwtVerify, SignJWT } from "jose";
const encoder = new TextEncoder();
export async function issueSession(
  username: string,
  secret: string,
  days: number,
  now: number,
): Promise<string> {
  const issued = Math.floor(now / 1000);
  return await new SignJWT({ sub: username }).setProtectedHeader({
    alg: "HS256",
  })
    .setIssuedAt(issued).setExpirationTime(issued + days * 86400).sign(
      encoder.encode(secret),
    );
}
export async function verifySession(
  token: string,
  username: string,
  secret: string,
  now: number,
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      algorithms: ["HS256"],
      currentDate: new Date(now),
      requiredClaims: ["exp", "iat", "sub"],
    });
    return payload.sub === username;
  } catch {
    return false;
  }
}
export function cookieToken(request: Request, name: string): string | null {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
export function sessionCookie(
  name: string,
  token: string,
  days: number,
): string {
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
    token ? days * 86400 : 0
  }`;
}
