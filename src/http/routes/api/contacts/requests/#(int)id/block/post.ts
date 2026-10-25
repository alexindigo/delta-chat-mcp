// SPDX-License-Identifier: LGPL-3.0-only
import {
  id,
  messagingRoute,
  parse,
} from "../../../../../../messaging-routes.ts";
export default messagingRoute(async (_request, app, params) => {
  await app.contacts.block(parse(id, params.id));
  return { ok: true };
});
