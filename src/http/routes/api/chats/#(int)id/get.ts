// SPDX-License-Identifier: LGPL-3.0-only
import { id, messagingRoute, parse } from "../../../../messaging-routes.ts";
export default messagingRoute((_request, app, params) =>
  app.chats.get(parse(id, params.id))
);
