// SPDX-License-Identifier: LGPL-3.0-only
import { authRoute } from "../../../../auth-routes.ts";
export const auth = false;
export default authRoute(async (request, app) =>
  Response.json(await app.auth.session(request))
);
