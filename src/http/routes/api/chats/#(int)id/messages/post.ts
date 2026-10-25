// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import {
  id,
  input,
  messagingRoute,
  parse,
} from "../../../../../messaging-routes.ts";
export default messagingRoute(async (request, app, params) =>
  app.send.sendText(
    parse(id, params.id),
    (await input(
      request,
      z.object({ text: z.string().min(1).max(100000) }).strict(),
    )).text,
  )
);
