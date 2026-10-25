// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
const handler: Handler = (request, { app }) => {
  const id = request.params.id;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
    return Response.json({ error: "Invalid key id" }, { status: 400 });
  }
  app.apiKeys.delete(id);
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
};
export default handler;
