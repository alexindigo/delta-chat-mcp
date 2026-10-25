// SPDX-License-Identifier: LGPL-3.0-only
import { authInput, authRoute } from "../../../auth-routes.ts";
import { AuthError } from "../../../../auth/state.ts";
export default authRoute(async (request, app) => {
  const { name = "" } = await authInput(request, ["name"]);
  if (!name.trim() || name.trim().length > 120) {
    throw new AuthError(400, "Key name must be 1–120 characters");
  }
  return Response.json(await app.apiKeys.create(name), {
    status: 201,
    headers: { "cache-control": "no-store" },
  });
});
