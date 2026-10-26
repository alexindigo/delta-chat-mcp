// SPDX-License-Identifier: LGPL-3.0-only
import type { Message } from "./messaging-types.ts";
import { messageImageUrl } from "./api.ts";

export interface AttachmentPresentation {
  src?: string;
  width?: number;
  height?: number;
  alt: string;
  status: string;
  retry: boolean;
}
/** Ephemeral consumer state, never a media journal. Canonical metadata controls
 * eligibility; ordinary refreshes cannot turn an image error into a refetch loop. */
export class Attachments {
  #entries = new Map<
    number,
    { key: string; attempt: number; failed: boolean }
  >();
  reconcile(messages: Message[]): Record<number, AttachmentPresentation> {
    const ids = new Set(messages.map((message) => message.id));
    for (const id of this.#entries.keys()) {
      if (!ids.has(id)) this.#entries.delete(id);
    }
    return Object.fromEntries(
      messages.map((message) => [message.id, this.present(message)]),
    );
  }
  private present(message: Message): AttachmentPresentation {
    const alt = message.attachmentName || "Received image";
    const result: AttachmentPresentation = { alt, status: "", retry: false };
    const labels = {
      Available: "Attachment not downloaded.",
      InProgress: "Attachment downloading…",
      Failure: "Attachment download failed.",
      Undecipherable: "Attachment could not be decrypted.",
      Done: "",
    };
    result.status = labels[message.attachmentDownloadState ?? "Done"];
    if (!message.inlineImage || result.status) {
      this.#entries.delete(message.id);
      return result;
    }
    const key = JSON.stringify(message.inlineImage);
    let entry = this.#entries.get(message.id);
    if (!entry || entry.key !== key) {
      entry = { key, attempt: 0, failed: false };
      this.#entries.set(message.id, entry);
    }
    if (entry.failed) {
      result.status = "Image could not be displayed.";
      result.retry = entry.attempt < 2;
    } else {
      result.src = messageImageUrl(message.id, entry.attempt);
      result.width = message.inlineImage.width;
      result.height = message.inlineImage.height;
    }
    return result;
  }
  event(id: number, src: string, failed: boolean) {
    const entry = this.#entries.get(id);
    if (!entry || messageImageUrl(id, entry.attempt) !== src) return;
    entry.failed = failed;
  }
  retry(id: number) {
    const entry = this.#entries.get(id);
    if (!entry?.failed || entry.attempt >= 2) return;
    entry.attempt++;
    entry.failed = false;
  }
  clear() {
    this.#entries.clear();
  }
}
