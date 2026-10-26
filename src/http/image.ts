// SPDX-License-Identifier: LGPL-3.0-only
import type { OpenImage } from "../messaging/attachments.ts";

/** Before return we own the handle; afterwards the native FsFile readable owns
 * EOF/error/cancel closure. Never cancel on request.signal after handoff: Deno
 * 2.9.6's legacy signal also aborts on successful response delivery. */
export function imageResponse(image: OpenImage, signal: AbortSignal): Response {
  try {
    signal.throwIfAborted();
    return new Response(image.file.readable, {
      headers: {
        "content-type": image.mimeType,
        "content-length": String(image.size),
        "content-disposition": "inline",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    image.file.close();
    throw error;
  }
}
