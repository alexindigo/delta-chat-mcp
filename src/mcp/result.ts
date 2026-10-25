// SPDX-License-Identifier: LGPL-3.0-only
export async function toolResult(
  action: () => Promise<Record<string, unknown>>,
) {
  try {
    const structuredContent = await action();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(structuredContent),
      }],
      structuredContent,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const reason = name === "CoreUnavailable"
      ? "core_unavailable"
      : name === "UnknownMessageAnchor" || name === "IdentityRequired"
      ? "not_found"
      : name === "AbortError"
      ? "cancelled"
      : "request_failed";
    const structuredContent = { error: reason };
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify(structuredContent),
      }],
      structuredContent,
    };
  }
}
