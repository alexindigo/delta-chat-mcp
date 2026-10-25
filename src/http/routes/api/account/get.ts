// SPDX-License-Identifier: LGPL-3.0-only
import { messagingRoute } from "../../../messaging-routes.ts";
export default messagingRoute(async (_request, app) => {
  const health = app.health();
  return {
    ...health,
    ...(health.core === "ready" ? await app.account.status() : {
      configured: health.configured,
      accountId: null,
      address: null,
      displayName: null,
      connectivity: null,
    }),
  };
});
