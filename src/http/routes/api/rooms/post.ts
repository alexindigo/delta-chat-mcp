// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { input, messagingRoute } from "../../../messaging-routes.ts";
export default messagingRoute(async (request, app) => {
  const value = await input(
    request,
    z.object({
      name: z.string().trim().min(1),
      contactIds: z.array(z.number().int().positive().max(0xffffffff)).max(100),
    }).strict(),
  );
  return app.rooms.createRoom(value.name, value.contactIds);
});
