// SPDX-License-Identifier: LGPL-3.0-only
import { messagingRoute } from "../../../../messaging-routes.ts";
export default messagingRoute((_request, app) => app.account.invitation());
