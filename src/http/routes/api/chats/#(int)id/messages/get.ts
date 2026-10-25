// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { id, messagingRoute, parse } from "../../../../../messaging-routes.ts";
export default messagingRoute(async (request, app, params) => {
  const range = parse(
    z.object({
      beforeId: id.optional(),
      afterId: id.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).strict(),
    Object.fromEntries(new URL(request.url).searchParams),
  );
  return { messages: await app.chats.messages(parse(id, params.id), range) };
});
