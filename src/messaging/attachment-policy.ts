// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreMessage } from "../core/client.ts";

export type RasterMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";
export interface InlineImage {
  mimeType: RasterMime;
  width?: number;
  height?: number;
}
/** Core v2.65 message.rs suffix policy and mimeparser.rs parse_attachments:
 * Image/Gif may become Sticker; File is never promoted by MIME or filename. */
export function imageType(message: CoreMessage): RasterMime | undefined {
  const mime = message.fileMime?.split(";", 1)[0].trim().toLowerCase();
  if (
    (message.viewType === "Image" || message.viewType === "Sticker") &&
    (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp")
  ) return mime;
  if (
    (message.viewType === "Gif" || message.viewType === "Sticker") &&
    mime === "image/gif"
  ) return mime;
}
export function inlineImage(message: CoreMessage): InlineImage | undefined {
  const mimeType = imageType(message);
  if (!mimeType || message.downloadState !== "Done" || !message.file) return;
  const valid = (n: number) => Number.isInteger(n) && n > 0 && n <= 2147483647;
  return {
    mimeType,
    ...(valid(message.dimensionsWidth) && valid(message.dimensionsHeight)
      ? { width: message.dimensionsWidth, height: message.dimensionsHeight }
      : {}),
  };
}
/** Bounded format signature, not a decoder. Browser decode remains authoritative. */
export function rasterSignature(bytes: Uint8Array, mime: RasterMime): boolean {
  const starts = (...prefix: number[]) =>
    prefix.every((value, index) => bytes[index] === value);
  const ascii = (offset: number, text: string) =>
    [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  switch (mime) {
    case "image/jpeg":
      return starts(255, 216, 255) && bytes.length >= 4 && bytes[3] !== 0;
    case "image/png":
      return starts(137, 80, 78, 71, 13, 10, 26, 10);
    case "image/gif":
      return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP") &&
        (ascii(12, "VP8 ") || ascii(12, "VP8L") || ascii(12, "VP8X"));
  }
}
