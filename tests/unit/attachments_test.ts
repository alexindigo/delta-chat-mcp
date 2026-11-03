// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { pathfinder } from "@pathfinder/pathfinder";
import type { CoreMessage } from "../../src/core/client.ts";
import {
  AttachmentError,
  AttachmentsService,
} from "../../src/messaging/attachments.ts";
import {
  imageType,
  inlineImage,
  rasterSignature,
} from "../../src/messaging/attachment-policy.ts";
import { toMessage } from "../../src/messaging/message.ts";
import { MessageLoadError } from "../../src/messaging/load.ts";
import { imageResponse } from "../../src/http/image.ts";
import { serveHttp } from "../../src/http/lifetime.ts";
import { FakeCore } from "./fake_core.ts";
import { authFixture } from "../auth_support.ts";
import { deadline, fixture, lanAddress, poll } from "../support.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const message = (patch: Partial<CoreMessage> = {}) => ({
  id: 42,
  chatId: 20,
  fromId: 9,
  text: "Caption",
  timestamp: 1,
  state: 10,
  viewType: "Image",
  downloadState: "Done",
  file: "/private/blob.png",
  fileName: "original.png",
  fileMime: "image/png",
  dimensionsWidth: 24,
  dimensionsHeight: 12,
  showPadlock: true,
  sender: { displayName: "Peer", address: "peer@example.org" },
  ...patch,
} as CoreMessage);

Deno.test("one raster policy gates core classifications, MIME, readiness and safe additive DTO", () => {
  const types = [
    "Image",
    "Gif",
    "Sticker",
    "File",
    "Text",
    "Video",
    "Webxdc",
  ] as const;
  const mimes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "image/heic",
    "text/html",
  ];
  for (const viewType of types) {
    for (const fileMime of mimes) {
      const allowed = ((viewType === "Image" || viewType === "Sticker") &&
        mimes.slice(0, 3).includes(fileMime)) ||
        ((viewType === "Gif" || viewType === "Sticker") &&
          fileMime === "image/gif");
      assertEquals(!!imageType(message({ viewType, fileMime })), allowed);
      assertEquals(!!inlineImage(message({ viewType, fileMime })), allowed);
    }
  }
  assertEquals(
    imageType(message({ fileMime: " IMAGE/PNG ; x=y" })),
    "image/png",
  );
  for (
    const downloadState of [
      "Available",
      "InProgress",
      "Failure",
      "Undecipherable",
    ] as const
  ) {
    assertEquals(inlineImage(message({ downloadState })), undefined);
    assertEquals(
      toMessage(message({ downloadState, file: null, fileName: null }), {
        text: "Caption",
        textComplete: false,
      })
        .attachmentDownloadState,
      downloadState,
    );
  }
  assertEquals(inlineImage(message({ file: null })), undefined);
  for (const width of [0, -1, NaN, Infinity, 1.2]) {
    assertEquals(inlineImage(message({ dimensionsWidth: width })), {
      mimeType: "image/png",
    });
  }
  const mapped = toMessage(message(), { text: "Caption", textComplete: true });
  assertEquals(mapped.inlineImage, {
    mimeType: "image/png",
    width: 24,
    height: 12,
  });
  assert(!JSON.stringify(mapped).includes("/private"));
  assertEquals(mapped.attachmentName, "original.png");
  assertEquals(mapped.text, "Caption");
  assert(rasterSignature(png, "image/png"));
  assert(!rasterSignature(png, "image/jpeg"));
  assert(!rasterSignature(new Uint8Array(), "image/png"));
  assert(rasterSignature(new TextEncoder().encode("GIF89a"), "image/gif"));
  assert(
    rasterSignature(new TextEncoder().encode("RIFF0000WEBPVP8L"), "image/webp"),
  );
});

async function setup() {
  const dir = await fixture("attachment-policy");
  const accounts = join(dir, "accounts"),
    root = join(accounts, "core-owned-root");
  await Deno.mkdir(root, { recursive: true });
  const path = join(root, "image.png");
  await Deno.writeFile(path, png);
  let current: CoreMessage | undefined = message({ file: path });
  let loadingError = false;
  const core = new FakeCore({
    getMessages: () =>
      Promise.resolve(
        current && !loadingError ? { 42: { ...current, kind: "message" } } : {
          42: {
            kind: "loadingError",
            error: "/private/password/blob missing",
          },
        },
      ),
    getExistingMsgIds: () => Promise.resolve(current ? [42] : []),
    getBlobDir: () => Promise.resolve(root),
  });
  const service = new AttachmentsService(
    core,
    { id: () => Promise.resolve(7) },
    accounts,
  );
  return {
    dir,
    accounts,
    root,
    path,
    core,
    service,
    set: (patch: Partial<CoreMessage>) =>
      current = message({ file: path, ...patch }),
    deleted: () => current = undefined,
    broken: () => loadingError = true,
  };
}

Deno.test("core-owned resolver rejects escapes, symlinks, nonfiles, unsupported and pending bytes without side effects", async () => {
  const f = await setup(), signal = new AbortController().signal;
  const open = () => f.service.openImage(42, signal);
  const good = await open();
  assertEquals(good.size, png.length);
  assertEquals(
    new Uint8Array(await imageResponse(good, signal).arrayBuffer()),
    png,
  );
  await assertRejects(() => good.file.stat(), Deno.errors.BadResource);
  assert(
    f.core.calls.some((call) =>
      call.method === "getBlobDir" && call.args[0] === 7
    ),
  );
  const sibling = `${f.root}-other`;
  await Deno.mkdir(sibling);
  await Deno.writeFile(join(sibling, "outside.png"), png);
  await Deno.symlink(f.path, join(f.root, "internal-link.png"));
  await Deno.symlink(
    join(sibling, "outside.png"),
    join(f.root, "external-link.png"),
  );
  for (
    const file of [
      null,
      join(sibling, "outside.png"),
      join(f.root, "internal-link.png"),
      join(f.root, "external-link.png"),
      f.root,
      join(f.root, "missing.png"),
    ]
  ) {
    f.set({ file });
    const error = await assertRejects(open, AttachmentError);
    assertEquals(error.status, 404);
    assert(!error.message.includes(f.dir));
  }
  for (
    const downloadState of [
      "Available",
      "InProgress",
      "Failure",
      "Undecipherable",
    ] as const
  ) {
    f.set({ downloadState });
    assertEquals((await assertRejects(open, AttachmentError)).status, 409);
  }
  for (
    const patch of [{ viewType: "File" }, {
      fileMime: "image/svg+xml",
    }] as Partial<CoreMessage>[]
  ) {
    f.set(patch);
    assertEquals((await assertRejects(open, AttachmentError)).status, 415);
  }
  const bad = join(f.root, "bad.png");
  await Deno.writeTextFile(bad, "<svg>not raster</svg>");
  f.set({ file: bad });
  assertEquals((await assertRejects(open, AttachmentError)).status, 415);
  f.set({});
  f.broken();
  await assertRejects(open, MessageLoadError);
  f.deleted();
  assertEquals((await assertRejects(open, AttachmentError)).status, 404);
  assert(
    !f.core.calls.some((call) =>
      /markseen|download|readMessages/.test(call.method)
    ),
  );
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => f.service.openImage(42, controller.signal),
    DOMException,
  );
});

Deno.test("discovered image route uses cookie auth, bounded IDs, deliberate HEAD and private binary/error headers", async () => {
  let now = Date.now();
  const f = await setup(), auth = await authFixture({}, () => now);
  try {
    const token = await auth.auth.setup({
      type: "password",
      username: "operator",
      password: "private-fixture",
    });
    const cookie = auth.auth.cookie(token!).split(";", 1)[0];
    const route = await pathfinder({
      roots: [new URL("../../src/http/routes/", import.meta.url)],
      app: {
        auth: auth.auth,
        apiKeys: auth.apiKeys,
        log: auth.log,
        attachments: f.service,
      },
    });
    const get = (
      headers: Record<string, string> = {},
      method = "GET",
      id = "42",
    ) =>
      route(
        new Request(`http://relay/api/messages/${id}/image`, {
          headers,
          method,
        }),
      );
    for (
      const headers of [{}, { authorization: "Bearer private-token" }, {
        cookie: "invalid",
      }] as Record<string, string>[]
    ) {
      const response = await get(headers);
      assertEquals(response.status, 401);
      assertEquals(response.headers.get("cache-control"), "no-store");
    }
    const response = await get({ cookie, range: "bytes=1-2" });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "image/png");
    assertEquals(response.headers.get("content-disposition"), "inline");
    assertEquals(response.headers.get("content-length"), String(png.length));
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
    assertEquals(
      response.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assertEquals(response.headers.get("access-control-allow-origin"), null);
    assertEquals(response.headers.get("accept-ranges"), null);
    assertEquals(new Uint8Array(await response.arrayBuffer()), png);
    assertEquals((await get({ cookie }, "HEAD")).status, 405);
    assertEquals((await get({}, "HEAD")).status, 401);
    for (const id of ["0", "4294967296", "9007199254740993"]) {
      assertEquals((await get({ cookie }, "GET", id)).status, 400);
    }
    f.core.available = false;
    const restarting = await get({ cookie });
    assertEquals(restarting.status, 503);
    assertEquals(restarting.headers.get("cache-control"), "no-store");
    f.core.available = true;
    f.broken();
    const failure = await get({ cookie });
    assertEquals(failure.status, 503);
    assertEquals(failure.headers.get("cache-control"), "no-store");
    assert(!JSON.stringify(await failure.json()).includes("private/password"));
    f.deleted();
    assertEquals((await get({ cookie })).status, 404);
    now += 400 * 24 * 60 * 60 * 1000;
    const expired = await get({ cookie });
    assertEquals(expired.status, 401);
    assertEquals(expired.headers.get("cache-control"), "no-store");
  } finally {
    auth.close();
  }
  const publicAuth = await authFixture();
  try {
    const route = await pathfinder({
      roots: [new URL("../../src/http/routes/", import.meta.url)],
      app: {
        auth: publicAuth.auth,
        log: publicAuth.log,
        attachments: (await setup()).service,
      },
    });
    const request = () => new Request("http://relay/api/messages/42/image");
    assertEquals((await route(request())).status, 503);
    await publicAuth.auth.setup({ type: "public" });
    const publicImage = await route(request());
    assertEquals(publicImage.status, 200);
    assertEquals(new Uint8Array(await publicImage.arrayBuffer()), png);
  } finally {
    publicAuth.close();
  }
});

Deno.test("real file streams close on EOF, cancellation, pre-handoff abort, native disconnect and bounded shutdown", async () => {
  const f = await setup(), signal = new AbortController().signal;
  let image = await f.service.openImage(42, signal);
  await imageResponse(image, signal).body!.cancel();
  await assertRejects(() => image.file.stat(), Deno.errors.BadResource);
  image = await f.service.openImage(42, signal);
  const failedConsumer = imageResponse(image, signal).body!.pipeThrough(
    new TransformStream({
      transform() {
        throw new Error("Controlled post-header consumer error");
      },
    }),
  );
  await assertRejects(
    () => new Response(failedConsumer).arrayBuffer(),
    Error,
    "Controlled post-header",
  );
  await poll(async () => {
    try {
      await image.file.stat();
      return false;
    } catch (error) {
      return error instanceof Deno.errors.BadResource;
    }
  });
  image = await f.service.openImage(42, signal);
  const aborted = new AbortController();
  aborted.abort();
  try {
    imageResponse(image, aborted.signal);
  } catch { /* asserted below */ }
  await assertRejects(() => image.file.stat(), Deno.errors.BadResource);
  // Large immutable fixture keeps the native response backpressured while a peer
  // deliberately does not read; only owned test files/connections are affected.
  const large = await Deno.open(f.path, { write: true });
  await large.truncate(32 * 1024 * 1024);
  large.close();
  for (const mode of ["disconnect", "shutdown", "complete"] as const) {
    let opened: Deno.FsFile | undefined;
    const http = serveHttp(
      { hostname: lanAddress(), port: 0 },
      async (request) => {
        const next = await f.service.openImage(42, request.signal);
        opened = next.file;
        return imageResponse(next, request.signal);
      },
    );
    let conn: Deno.TcpConn | undefined;
    try {
      if (mode === "complete") {
        const response = await fetch(
          `http://${lanAddress()}:${http.addr.port}/`,
        );
        assertEquals(
          (await response.arrayBuffer()).byteLength,
          32 * 1024 * 1024,
        );
      } else {
        conn = await Deno.connect({
          hostname: lanAddress(),
          port: http.addr.port,
        });
        await conn.write(
          new TextEncoder().encode("GET / HTTP/1.1\r\nHost: fixture\r\n\r\n"),
        );
        await poll(() => !!opened);
        if (mode === "disconnect") {
          conn.close();
          conn = undefined;
        } else await deadline(http.close(), 3000);
      }
      await poll(async () => {
        try {
          await opened!.stat();
          return false;
        } catch (error) {
          return error instanceof Deno.errors.BadResource;
        }
      });
    } finally {
      conn?.close();
      await deadline(http.close(), 3000);
    }
  }
});

Deno.test("late core resolution after abort cannot open a response file", async () => {
  const f = await setup();
  const original = f.core.handlers.getMessages!;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.core.handlers.getMessages = async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  };
  const abort = new AbortController();
  const result = f.service.openImage(42, abort.signal);
  await entered.promise;
  abort.abort();
  release.resolve();
  await assertRejects(() => result, DOMException);
});
