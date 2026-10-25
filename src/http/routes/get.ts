// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import { staticResponse } from "../static.ts";
const handler: Handler = (request) => staticResponse(request._raw);
export default handler;
