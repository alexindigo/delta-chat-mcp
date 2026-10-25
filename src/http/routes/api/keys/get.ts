// SPDX-License-Identifier: LGPL-3.0-only
import { authRoute } from "../../../auth-routes.ts";
export default authRoute((_request, app) =>
  Promise.resolve(
    Response.json({ keys: app.apiKeys.list() }, {
      headers: { "cache-control": "no-store" },
    }),
  )
);
