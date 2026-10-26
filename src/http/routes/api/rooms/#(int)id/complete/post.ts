// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import {
  id,
  input,
  messagingRoute,
  parse,
} from "../../../../../messaging-routes.ts";
export default messagingRoute(async (request, app, params) => {
  const value = await input(
    request,
    z.object({
      contactIds: z.array(z.number().int().positive().max(0xffffffff)).max(100),
    }).strict(),
  );
  return app.rooms.completeRoom(parse(id, params.id), value.contactIds);
});
