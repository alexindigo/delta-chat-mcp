// SPDX-License-Identifier: LGPL-3.0-only
export type Screen = "keys" | "identity" | "contacts" | "chats";
/** Single browser location capability. Navigation uses normal links and SPA documents. */
export function browserLocation() {
  const path = location.pathname.split("/").filter(Boolean)[0];
  return {
    origin: location.origin,
    screen:
      (["identity", "contacts", "chats"].includes(path)
        ? path
        : "keys") as Screen,
  };
}
export function openCodeConfig(origin: string, publicMode: boolean) {
  return JSON.stringify(
    {
      mcp: {
        "delta-chat": {
          type: "remote",
          url: `${origin}/mcp`,
          oauth: false,
          ...(publicMode ? {} : {
            headers: { Authorization: "Bearer {env:DELTA_CHAT_MCP_KEY}" },
          }),
          enabled: false,
        },
      },
    },
    null,
    2,
  );
}
