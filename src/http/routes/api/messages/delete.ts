// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { ids, input, messagingRoute } from "../../../messaging-routes.ts";
export default messagingRoute(async (request, app) => {
  await app.delete.deleteMessages(
    (await input(request, z.object({ ids }).strict())).ids,
  );
  return { ok: true };
});
