// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Attachments } from "../../web/src/attachments.ts";
import type { Message } from "../../web/src/messaging-types.ts";

Deno.test("media presenter keeps failures through canonical refresh, bounds explicit retry and drops stale/deleted state", () => {
  const presenter = new Attachments();
  const message = {
    id: 42,
    inlineImage: { mimeType: "image/png", width: 10, height: 20 },
    attachmentName: "a.png",
  } as Message;
  let view = presenter.reconcile([message])[42];
  assertEquals(view.src, "/api/messages/42/image");
  for (let attempt = 0; attempt < 3; attempt++) {
    presenter.event(42, view.src!, true);
    view = presenter.reconcile([{ ...message }])[42];
    assertEquals(view.src, undefined);
    assertEquals(view.status, "Image could not be displayed.");
    assertEquals(view.retry, attempt < 2);
    presenter.retry(42);
    view = presenter.reconcile([message])[42];
  }
  assertEquals(view.src, undefined);
  presenter.reconcile([]);
  view = presenter.reconcile([message])[42];
  assertEquals(view.src, "/api/messages/42/image");
  presenter.event(42, "stale-url", true);
  assertEquals(presenter.reconcile([message])[42].src, view.src);
  for (
    const attachmentDownloadState of [
      "Available",
      "InProgress",
      "Failure",
      "Undecipherable",
    ] as const
  ) {
    const pending = presenter.reconcile([{
      ...message,
      inlineImage: undefined,
      attachmentDownloadState,
    }])[42];
    assertEquals(pending.src, undefined);
    assertEquals(!!pending.status, true);
    assertEquals(pending.retry, false);
  }
  presenter.clear();
});
