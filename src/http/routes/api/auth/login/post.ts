// SPDX-License-Identifier: LGPL-3.0-only
import { authInput, authRoute } from "../../../../auth-routes.ts";
export const auth = false;
export default authRoute(async (request, app) => {
  const input = await authInput(request, ["username", "password", "code"]);
  const token = await app.auth.login(
    input.username ?? "",
    input.password ?? "",
    input.code,
  );
  return Response.json({ authenticated: true }, {
    headers: token ? { "set-cookie": app.auth.cookie(token) } : {},
  });
});
