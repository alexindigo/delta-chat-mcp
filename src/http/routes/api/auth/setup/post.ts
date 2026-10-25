// SPDX-License-Identifier: LGPL-3.0-only
import { authInput, authRoute } from "../../../../auth-routes.ts";
export const auth = false;
export default authRoute(async (request, app) => {
  const input = await authInput(request, [
    "type",
    "username",
    "password",
    "totpkey",
    "code",
  ]);
  const token = await app.auth.setup({ ...input, type: input.type ?? "" });
  return Response.json({
    setupRequired: false,
    mode: app.auth.mode,
    authenticated: true,
    username: app.auth.username,
  }, { headers: token ? { "set-cookie": app.auth.cookie(token) } : {} });
});
