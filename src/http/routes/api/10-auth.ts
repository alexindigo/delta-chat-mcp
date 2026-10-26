// SPDX-License-Identifier: LGPL-3.0-only
import type { Middleware } from "@pathfinder/pathfinder";
declare module "@pathfinder/pathfinder" {
  interface Meta {
    auth?: boolean;
    stream?: boolean;
  }
}
const middleware: Middleware = async (request, { app, meta }) => {
  const reject = (error: string, status: number) =>
    Response.json({ error }, {
      status,
      headers: { "cache-control": "no-store" },
    });
  if (meta.auth !== false && app.auth.setupRequired) {
    return reject("Setup required", 503);
  }
  if (app.auth.mode === "public") return;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const streaming = meta.stream === true ||
    request.headers.get("accept")?.includes("text/event-stream");
  const origin = new URL(request._raw.url).origin;
  let streamOrigin = request.headers.get("origin");
  // Plain-HTTP native EventSource omits Origin/Fetch Metadata. Its Referer
  // still proves same-origin; absent both fails closed, never wildcard CORS.
  if (streaming && !streamOrigin) {
    try {
      streamOrigin = new URL(request.headers.get("referer") ?? "").origin;
    } catch { /* Missing/invalid provenance is rejected below. */ }
  }
  if (
    (mutating && request.headers.get("origin") !== origin) ||
    (streaming && streamOrigin !== origin)
  ) return reject("Origin not allowed", 403);
  if (meta.auth !== false && !await app.auth.authenticated(request._raw)) {
    return reject("Authentication required", 401);
  }
};
export default middleware;
