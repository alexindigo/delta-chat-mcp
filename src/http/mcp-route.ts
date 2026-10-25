// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";

declare module "@pathfinder/pathfinder" {
  interface App {
    mcp?: {
      handleRequest(request: Request, owner?: string): Promise<Response>;
    };
  }
}

const handler: Handler = (request, context) =>
  context.app.mcp?.handleRequest(request._raw, context.state.apiKeyId) ??
    Response.json({ error: "MCP transport not installed" }, { status: 501 });

export default handler;
