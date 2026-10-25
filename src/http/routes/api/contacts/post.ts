// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { input, messagingRoute } from "../../../messaging-routes.ts";
export default messagingRoute(async (request, app) =>
  app.contacts.joinByInvite(
    (await input(
      request,
      z.object({ link: z.string().trim().min(1).max(16384) }).strict(),
    )).link,
  )
);
