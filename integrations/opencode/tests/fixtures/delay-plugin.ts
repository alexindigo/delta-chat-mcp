// SPDX-License-Identifier: LGPL-3.0-only
// F20: hold/throw after selection but before native message/part persistence.
export default function delay() {
  return {
    async "chat.message"(
      input: { messageID?: string },
      output: { parts: { metadata?: Record<string, unknown> }[] },
    ) {
      if (!output.parts.some((part) => part.metadata?.j0Hold)) return;
      const response = await fetch(
        `${process.env.DCMCP_DELAY_URL}/hold/${input.messageID}`,
        { method: "POST" },
      );
      await response.body?.cancel();
      if (!response.ok) throw new Error("j0-deliberate-admission-error");
    },
  };
}
