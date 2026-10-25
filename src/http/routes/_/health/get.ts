// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
export const auth = false;
const handler: Handler = (_request, context) =>
  Response.json(context.app.health());
export default handler;
