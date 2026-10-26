// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, isAbsolute, relative } from "@std/path";
import type { CoreClient } from "../core/client.ts";
import type { AccountService } from "./account.ts";
import { loadMessages } from "./load.ts";
import {
  imageType,
  type RasterMime,
  rasterSignature,
} from "./attachment-policy.ts";

export class AttachmentError extends Error {
  constructor(readonly status: 404 | 409 | 415, message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}
export interface OpenImage {
  file: Deno.FsFile;
  size: number;
  mimeType: RasterMime;
}
const unavailable = () => new AttachmentError(404, "Image unavailable");
const contained = (root: string, path: string) => {
  const child = relative(root, path);
  return !!child && !isAbsolute(child) && child !== ".." &&
    !child.split(/[\\/]/).includes("..");
};
/** Core owns files and history. No caller supplies an account or filesystem path. */
export class AttachmentsService {
  constructor(
    private core: CoreClient,
    private account: Pick<AccountService, "id">,
    private accountsDir: string,
  ) {}
  async openImage(id: number, signal: AbortSignal): Promise<OpenImage> {
    signal.throwIfAborted();
    const account = await this.account.id();
    const { message, blobDir } = await this.core.use(async (rpc) => ({
      message: (await loadMessages(rpc, account, [id])).get(id),
      blobDir: await rpc.getBlobDir(account),
    }));
    signal.throwIfAborted();
    if (!message) throw unavailable();
    if (message.downloadState !== "Done") {
      throw new AttachmentError(
        409,
        "Attachment is not downloaded or unavailable",
      );
    }
    const mimeType = imageType(message);
    if (!mimeType) throw new AttachmentError(415, "Unsupported inline image");
    if (!message.file || !blobDir) throw unavailable();
    let file: Deno.FsFile | undefined;
    try {
      const accounts = await Deno.realPath(this.accountsDir);
      const root = await Deno.realPath(blobDir);
      const candidate = await Deno.realPath(message.file);
      // Core blobs are direct children. Reject even internal symlinks; parent
      // symlinks cannot silently move the selected account outside its root.
      const entry = await Deno.lstat(message.file);
      if (
        !contained(accounts, root) || !contained(root, candidate) ||
        dirname(candidate) !== root || entry.isSymlink || !entry.isFile
      ) throw unavailable();
      signal.throwIfAborted();
      file = await Deno.open(candidate, { read: true });
      const stat = await file.stat();
      if (
        !stat.isFile || stat.size <= 0 || !Number.isSafeInteger(stat.size) ||
        stat.dev !== entry.dev || stat.ino !== entry.ino
      ) throw unavailable();
      const header = new Uint8Array(Math.min(32, stat.size));
      let count = 0;
      while (count < header.length) {
        const n = await file.read(header.subarray(count));
        if (n === null) break;
        count += n;
      }
      if (!rasterSignature(header.subarray(0, count), mimeType)) {
        throw new AttachmentError(415, "Unsupported inline image");
      }
      await file.seek(0, Deno.SeekMode.Start);
      signal.throwIfAborted();
      const result = { file, size: stat.size, mimeType };
      file = undefined; // Receiver owns it until HTTP hands off to readable.
      return result;
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof AttachmentError) throw error;
      throw unavailable(); // Never export a core path or filesystem diagnostic.
    } finally {
      file?.close();
    }
  }
}
