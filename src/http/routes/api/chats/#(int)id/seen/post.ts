// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import {
  id,
  ids,
  input,
  messagingRoute,
  parse,
} from "../../../../../messaging-routes.ts";
export default messagingRoute(async (request, app, params) => {
  const chatId = parse(id, params.id),
    selected = (await input(request, z.object({ ids }).strict())).ids;
  // Only selected messages of this chat, never GET inspection or another page.
  await app.chats.markPresented(chatId, selected);
  return { ok: true };
});
