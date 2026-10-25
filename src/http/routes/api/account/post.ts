// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { input, messagingRoute } from "../../../messaging-routes.ts";
export default messagingRoute(async (request, app) =>
  app.account.create(
    await input(
      request,
      z.object({
        relay: z.string().trim().min(1).max(4096),
        displayName: z.string().trim().min(1).max(120),
      }).strict(),
    ),
  )
);
