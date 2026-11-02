// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { basename, dirname } from "@std/path";
import { evidenceDirectory, fixture } from "../support.ts";

Deno.test("evidence allocation creates a never-created parent and preserves earlier captures on repeat", async () => {
  const root = await fixture("evidence-directory"),
    parent = `${root}/never-created/nested`;
  await assertRejects(() => Deno.stat(parent), Deno.errors.NotFound);
  const first = await evidenceDirectory(parent, "capture-");
  await Deno.writeTextFile(`${first}/proof.txt`, "retained capture");
  const second = await evidenceDirectory(parent, "capture-");
  assert(first !== second);
  for (const child of [first, second]) {
    assertEquals(dirname(child), parent);
    assert(basename(child).startsWith("capture-"));
    assert((await Deno.stat(child)).isDirectory);
  }
  assertEquals(
    await Deno.readTextFile(`${first}/proof.txt`),
    "retained capture",
  );
});

Deno.test("concurrent evidence allocations independently create one cold parent and unique children", async () => {
  const root = await fixture("evidence-directory"),
    parent = `${root}/also-never-created/nested`;
  await assertRejects(() => Deno.stat(parent), Deno.errors.NotFound);
  const children = await Promise.all(
    Array.from({ length: 16 }, () => evidenceDirectory(parent, "parallel-")),
  );
  assertEquals(new Set(children).size, 16);
  for (const child of children) {
    assertEquals(dirname(child), parent);
    assert(basename(child).startsWith("parallel-"));
    assert((await Deno.stat(child)).isDirectory);
  }
});

Deno.test("evidence allocation propagates an unusable parent without replacing its contents", async () => {
  const root = await fixture("evidence-directory"),
    parent = `${root}/existing-file`;
  await Deno.writeTextFile(parent, "must remain a file");
  const error = await assertRejects(() =>
    evidenceDirectory(parent, "blocked-")
  );
  assert(
    error instanceof Deno.errors.AlreadyExists ||
      error instanceof Deno.errors.NotADirectory,
  );
  assertEquals(await Deno.readTextFile(parent), "must remain a file");
});
