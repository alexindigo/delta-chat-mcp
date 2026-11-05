// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { command, deadline, withOwners } from "./common.ts";
import { aliases, stable } from "./metadata.ts";

Deno.test("stable aliases never retreat across patch, minor or major release lines", () => {
  assertEquals(aliases("v0.1.0", []), ["0.1.0", "0.1", "latest"]);
  assertEquals(aliases("v0.1.0", ["v0.1.1"]), ["0.1.0"]);
  assertEquals(aliases("v1.3.4", ["v1.4.0"]), ["1.3.4", "1.3"]);
  assertEquals(aliases("v1.3.4", ["v2.0.0"]), ["1.3.4", "1.3", "1"]);
  for (const tag of ["v1.2", "v01.2.3", "v1.2.3-rc1", "1.2.3"]) {
    assertThrows(() => stable(tag));
  }
});

Deno.test("notice stdout preserves non-UTF8 bytes and terminal whitespace verbatim", async () => {
  const expected = new Uint8Array([0xff, 0x00, 0x61, 0x20, 0x0a, 0x0a]);
  let actual: Uint8Array | undefined;
  await command(Deno.execPath(), [
    "eval",
    "await Deno.stdout.write(new Uint8Array([255,0,97,32,10,10]))",
  ], {
    ms: 10000,
    raw: (bytes) => {
      actual = bytes;
      return Promise.resolve();
    },
  });
  assertEquals(actual, expected);
});

Deno.test("failed setup and a failed close still join every acquired real process", async () => {
  const children: Deno.ChildProcess[] = [];
  const failure = await assertRejects(() =>
    withOwners((own) => {
      for (let i = 0; i < 2; i++) {
        const child = new Deno.Command("sleep", { args: ["60"] }).spawn();
        children.push(child);
        own(async () => {
          child.kill("SIGTERM");
          await deadline(child.status, 5000);
          if (i === 1) {
            throw new Error("injected cleanup failure after joining");
          }
        });
      }
      return Promise.reject(new Error("injected partial setup failure"));
    }), AggregateError);
  assertEquals(failure.errors.length, 2);
  assertEquals(children.length, 2);
  for (const child of children) {
    assertThrows(() => Deno.kill(child.pid, 0), Deno.errors.NotFound);
  }
});
