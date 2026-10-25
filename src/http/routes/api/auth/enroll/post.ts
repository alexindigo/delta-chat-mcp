// SPDX-License-Identifier: LGPL-3.0-only
import { authInput, authRoute } from "../../../../auth-routes.ts";
export const auth = false;
export default authRoute(async (request, app) => {
  const input = await authInput(request, ["username"]);
  return Response.json(await app.auth.enroll(input.username ?? ""));
});
