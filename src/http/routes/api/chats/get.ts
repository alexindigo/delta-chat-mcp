// SPDX-License-Identifier: LGPL-3.0-only
import { messagingRoute } from "../../../messaging-routes.ts";
export default messagingRoute(async (_request, app) => ({
  chats: await app.chats.list(),
}));
