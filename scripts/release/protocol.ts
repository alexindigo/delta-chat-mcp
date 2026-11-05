// SPDX-License-Identifier: LGPL-3.0-only
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { deadline, requireThat } from "./common.ts";

export async function api(
  url: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    status?: number;
  } = {},
) {
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Origin: url,
      Cookie: options.cookie ?? "",
      "content-type": "application/json",
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(120000),
  });
  requireThat(
    response.status === (options.status ?? 200),
    `${path}: HTTP ${response.status}`,
  );
  return response;
}
export async function connect(url: string, key?: string) {
  const client = new Client({
    name: "packaged-artifact-proof",
    version: "0.1.0",
  });
  try {
    await deadline(
      client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: key
            ? { headers: { Authorization: `Bearer ${key}` } }
            : undefined,
        }),
      ),
      15000,
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
export async function tool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, {
    timeout: 70000,
  });
  requireThat(
    !result.isError && result.structuredContent,
    `MCP ${name} failed`,
  );
  return result.structuredContent as T;
}
