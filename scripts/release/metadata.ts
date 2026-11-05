// SPDX-License-Identifier: LGPL-3.0-only
import { command, requireThat } from "./common.ts";

export function stable(tag: string): number[] {
  requireThat(
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag),
    "Expected stable vX.Y.Z tag",
  );
  const parts = tag.slice(1).split(".").map(Number);
  requireThat(
    parts.every(Number.isSafeInteger),
    "Version exceeds integer range",
  );
  return parts;
}
const compare = (a: number[], b: number[]) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export function aliases(tag: string, tags: string[]) {
  const current = stable(tag), [major, minor] = current;
  const versions = tags.filter((t) =>
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(t)
  ).map(stable);
  const highest = (predicate: (v: number[]) => boolean) =>
    !versions.some((v) => predicate(v) && compare(v, current) > 0);
  return [
    tag.slice(1),
    ...(highest((v) => v[0] === major && v[1] === minor)
      ? [`${major}.${minor}`]
      : []),
    ...(major !== 0 && highest((v) => v[0] === major) ? [String(major)] : []),
    ...(highest(() => true) ? ["latest"] : []),
  ];
}
export async function metadata(tag?: string) {
  const version = (await Deno.readTextFile("VERSION")).trim();
  const releaseTag = tag ?? `v${version}`;
  stable(releaseTag);
  requireThat(releaseTag === `v${version}`, "Tag and VERSION differ");
  const changelog = await Deno.readTextFile("CHANGELOG.md");
  const section = changelog.split(`## ${version} - `);
  requireThat(
    section.length === 2 && /^\d{4}-\d{2}-\d{2}\n/.test(section[1]),
    "Unambiguous dated changelog required",
  );
  const notes = section[1].split("\n").slice(1).join("\n").split("\n## ")[0]
    .trim();
  requireThat(notes.length > 0, "Release notes absent");
  const tags = (await command("git", ["tag", "--list"])).split("\n");
  if (tag) {
    await command("git", ["fetch", "origin", "main:refs/remotes/origin/main"], {
      ms: 60000,
    });
    await command("git", [
      "merge-base",
      "--is-ancestor",
      "HEAD",
      "origin/main",
    ]);
    requireThat(
      await command("git", ["rev-parse", `${tag}^{commit}`]) ===
        await command("git", ["rev-parse", "HEAD"]),
      "Tag does not identify checked-out merged source",
    );
  }
  return {
    version,
    tag: releaseTag,
    aliases: aliases(releaseTag, tags),
    notes,
  };
}
if (import.meta.main) {
  console.log(JSON.stringify(await metadata(Deno.args[0]), null, 2));
}
