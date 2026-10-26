// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { messagingRoute, parse } from "../../../../../messaging-routes.ts";
import { imageResponse } from "../../../../../image.ts";

export default messagingRoute(async (request, app, params) => {
  const id = parse(
    z.coerce.number().int().positive().max(4294967295),
    params.id,
  );
  return imageResponse(
    await app.attachments.openImage(id, request.signal),
    request.signal,
  );
});
