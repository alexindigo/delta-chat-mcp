// SPDX-License-Identifier: LGPL-3.0-only
import type { Middleware } from "@pathfinder/pathfinder";
declare module "@pathfinder/pathfinder" {
  interface State {
    apiKeyId?: string;
  }
}
const middleware: Middleware = async (request, { app, state }) => {
  if (app.auth.setupRequired) {
    return Response.json({ error: "Setup required" }, { status: 503 });
  }
  if (app.auth.mode === "public") return;
  const id = await app.apiKeys.authenticate(request._raw);
  if (!id) {
    return Response.json({ error: "Bearer key required" }, {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  state.apiKeyId = id;
};
export default middleware;
