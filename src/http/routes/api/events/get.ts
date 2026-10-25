// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
export const stream = true;
const handler: Handler = (request, { app }) =>
  app.streams!.response(request._raw);
export default handler;
