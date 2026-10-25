// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import type { SpikeMcp } from "../mcp/spike.ts";

declare module "@pathfinder/pathfinder" {
  interface App {
    mcp?: Pick<SpikeMcp, "handleRequest">;
  }
}

const handler: Handler = (request, context) =>
  context.app.mcp?.handleRequest(request._raw) ??
    Response.json({ error: "MCP transport not installed" }, { status: 501 });

export default handler;
