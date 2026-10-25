// SPDX-License-Identifier: LGPL-3.0-only
import { authRoute } from "../../../../auth-routes.ts";
export default authRoute((request, app) => {
  app.streams?.logout(request);
  return Promise.resolve(
    new Response(null, {
      status: 204,
      headers: { "set-cookie": app.auth.cookie("") },
    }),
  );
});
