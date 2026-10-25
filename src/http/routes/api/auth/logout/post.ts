// SPDX-License-Identifier: LGPL-3.0-only
import { authRoute } from "../../../../auth-routes.ts";
export default authRoute((_request, app) =>
  Promise.resolve(
    new Response(null, {
      status: 204,
      headers: { "set-cookie": app.auth.cookie("") },
    }),
  )
);
