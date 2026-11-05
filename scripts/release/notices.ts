// SPDX-License-Identifier: LGPL-3.0-only
import { parse } from "@std/toml";
import { basename, join } from "@std/path";
import {
  argument,
  command,
  copyFile,
  requireThat,
  sha256,
  workspace,
} from "./common.ts";

type Notice = {
  component: string;
  version: string;
  source: string;
  path: string;
  sha256: string;
  kind: string;
};
const spdxRoot =
  "https://raw.githubusercontent.com/spdx/license-list-data/8a04f0303d95c4f932210b118588c662665bd383";
const standardTexts = new Map<string, Promise<Uint8Array>>();
let knownSpdx: Promise<Set<string>> | undefined;
async function standardIds(expression: string): Promise<string[] | undefined> {
  knownSpdx ??= Promise.all([
    download(`${spdxRoot}/json/licenses.json`),
    download(`${spdxRoot}/json/exceptions.json`),
  ])
    .then(([a, b]) =>
      new Set([
        ...JSON.parse(new TextDecoder().decode(a)).licenses.map((
          l: { licenseId: string },
        ) => l.licenseId),
        ...JSON.parse(new TextDecoder().decode(b)).exceptions.map((
          e: { licenseExceptionId: string },
        ) => e.licenseExceptionId),
      ])
    );
  const tokens = expression.replaceAll("/", " OR ").replaceAll(/[()]/g, " ")
    .split(/\s+/).filter(Boolean);
  const ids = tokens.filter((t) => !["AND", "OR", "WITH"].includes(t)).map((
    t,
  ) => t.replace(/\+$/, ""));
  const known = await knownSpdx;
  return ids.length && ids.every((id) => known.has(id))
    ? [...new Set(ids)]
    : undefined;
}
const upstream = [
  {
    name: "deno",
    version: "2.9.6",
    repo: "denoland/deno",
    license: "LICENSE.md",
    licenseHash:
      "f62497fffecc0852960c8d3e6934b9db86d16396e9b604072e923892cae3a588",
    lockHash:
      "6c6af74640994cc41fcc7f46bb5204a50da679adc2dee96cb05aa97867baf7e1",
  },
  {
    name: "core",
    version: "2.65.0",
    repo: "chatmail/core",
    license: "LICENSE",
    licenseHash:
      "8886770921c38b0a6704122d3eaf7c23aeaeb4d5b73dd703c16c74445c083072",
    lockHash:
      "c7e64380f930f7c9430878c30512095feeff6fd10e4f5109aa931c95ce6e4489",
  },
];
async function download(url: string, expected?: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  requireThat(response.ok, `Notice source ${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (expected) {
    requireThat(await sha256(bytes) === expected, `Notice checksum: ${url}`);
  }
  return bytes;
}
export async function notices(
  stage: string,
  work: string,
  output = join(stage, "licenses"),
  cache = work,
) {
  await Deno.mkdir(output, { recursive: true });
  await Deno.mkdir(work, { recursive: true });
  const inventory: Notice[] = [];
  const save = async (
    component: string,
    version: string,
    source: string,
    name: string,
    bytes: Uint8Array,
    kind = "upstream-text",
  ) => {
    const safe = component.replaceAll(/[^a-zA-Z0-9.-]/g, "_");
    const path = `${safe}-${version}-${
      name.replaceAll(/[^a-zA-Z0-9.-]/g, "_")
    }.txt`;
    await Deno.writeFile(join(output, path), bytes);
    inventory.push({
      component,
      version,
      source,
      path,
      sha256: await sha256(bytes),
      kind,
    });
  };
  const coreLicense = await download(
    `https://raw.githubusercontent.com/chatmail/core/v2.65.0/LICENSE`,
    upstream[1].licenseHash,
  );
  const root = join(stage, "node_modules/.deno");
  const packages = new Map<
    string,
    { dir: string; name: string; version: string }
  >();
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || entry.name === "node_modules") continue;
    const base = join(root, entry.name, "node_modules");
    for await (const ns of Deno.readDir(base)) {
      if (!ns.isDirectory) continue;
      const dirs = ns.name.startsWith("@")
        ? [...Deno.readDirSync(join(base, ns.name))].filter((d) =>
          d.isDirectory
        ).map((d) => join(base, ns.name, d.name))
        : [join(base, ns.name)];
      for (const dir of dirs) {
        const pkg = JSON.parse(
          await Deno.readTextFile(join(dir, "package.json")),
        );
        packages.set(`${pkg.name}@${pkg.version}`, {
          dir,
          name: pkg.name,
          version: pkg.version,
        });
      }
    }
  }
  for (
    const pkg of [...packages.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  ) {
    let texts = [...Deno.readDirSync(pkg.dir)].filter((f) =>
      f.isFile && /license|notice|copyright/i.test(f.name)
    );
    let textDir = pkg.dir;
    if (
      !texts.length &&
      (pkg.name === "solid-js" || pkg.name.startsWith("@solidjs/"))
    ) {
      textDir = packages.get("@solidjs/signals@2.0.0-rc.18")!.dir;
      texts = [...Deno.readDirSync(textDir)].filter((f) =>
        f.isFile && /license/i.test(f.name)
      );
    }
    if (!texts.length && pkg.name.startsWith("@rolldown/binding-")) {
      textDir = packages.get("rolldown@1.2.15")!.dir;
      texts = [...Deno.readDirSync(textDir)].filter((f) =>
        f.isFile && /license/i.test(f.name)
      );
    }
    for (const text of texts) {
      await save(
        pkg.name,
        pkg.version,
        `npm:${pkg.name}@${pkg.version}; text from ${
          textDir.slice(root.length + 1)
        }/${text.name}`,
        text.name,
        await Deno.readFile(join(textDir, text.name)),
      );
    }
    if (texts.length) continue;
    if (pkg.name.startsWith("@deltachat/") && pkg.version === "2.65.0") {
      await save(
        pkg.name,
        pkg.version,
        "https://github.com/chatmail/core/blob/v2.65.0/LICENSE",
        "LICENSE",
        coreLicense,
      );
    } else if (pkg.name === "yerpc") {
      const url =
        "https://raw.githubusercontent.com/deltachat/yerpc/ed9aeba099bb521f2c3ee0de16c5cd94b0be8dcf/LICENSE-MIT";
      await save(
        pkg.name,
        pkg.version,
        url,
        "LICENSE-MIT",
        await download(url),
      );
    } else if (pkg.name === "@napi-rs/wasm-runtime") {
      const url =
        "https://raw.githubusercontent.com/napi-rs/napi-rs/023a9f067af5d44c9a06c9a30b48fdd50ab18ac0/LICENSE";
      await save(pkg.name, pkg.version, url, "LICENSE", await download(url));
    } else {throw new Error(
        `No authoritative license text for ${pkg.name}@${pkg.version}`,
      );}
  }
  for (
    const [name, version] of [
      ["path", "1.1.5"],
      ["toml", "1.0.11"],
      ["internal", "1.0.14"],
      ["collections", "1.4.0"],
      ["assert", "1.0.19"],
    ]
  ) {
    const url = `https://jsr.io/@std/${name}/${version}/LICENSE`;
    await save(`@std/${name}`, version, url, "LICENSE", await download(url));
  }
  const pathfinder = "https://jsr.io/@pathfinder/pathfinder/0.2.4/LICENSE";
  await save(
    "pathfinder",
    "0.2.4",
    pathfinder,
    "LICENSE",
    await download(pathfinder),
  );
  // Include all lockfile crates, a conservative superset of linked native code.
  const crates = new Map<
    string,
    { name: string; version: string; checksum: string }
  >();
  for (const p of upstream) {
    const base = `https://raw.githubusercontent.com/${p.repo}/v${p.version}`;
    await save(
      p.name,
      p.version,
      `${base}/${p.license}`,
      "LICENSE",
      await download(`${base}/${p.license}`, p.licenseHash),
    );
    const lock = await download(`${base}/Cargo.lock`, p.lockHash);
    const parsed = parse(new TextDecoder().decode(lock));
    for (
      const c of parsed.package as {
        name: string;
        version: string;
        source?: string;
        checksum: string;
      }[]
    ) {
      if (!c.source) continue;
      requireThat(
        c.source === "registry+https://github.com/rust-lang/crates.io-index",
        `Unresolved native source ${c.source}`,
      );
      crates.set(`${c.name}@${c.version}`, c);
    }
  }
  const queue = [...crates.values()];
  const missing: unknown[] = [];
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const crate = queue.shift();
      if (!crate) break;
      const { name, version, checksum } = crate;
      const archive = join(cache, `${name}-${version}.crate`);
      try {
        requireThat(
          await sha256(await Deno.readFile(archive)) === checksum,
          "Cached crate checksum",
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await Deno.writeFile(
          archive,
          await download(
            `https://static.crates.io/crates/${name}/${name}-${version}.crate`,
            checksum,
          ),
        );
      }
      const contents = (await command("tar", ["-tzf", archive])).split("\n");
      const paths = contents
        .filter((path) =>
          /^(license|copying|notice|copyright)([._-]|$)/i.test(
            basename(path),
          ) && !path.endsWith("/")
        );
      if (!paths.length) {
        const cargoPath = `${name}-${version}/Cargo.toml`;
        const metadata = parse(
          await command("tar", ["-xOzf", archive, cargoPath]),
        );
        const pkg = metadata.package as {
          repository?: string;
          license?: string;
          "license-file"?: string;
        };
        const vcsPath = `${name}-${version}/.cargo_vcs_info.json`;
        const vcs = contents.includes(vcsPath)
          ? JSON.parse(await command("tar", ["-xOzf", archive, vcsPath]))
          : undefined;
        const repo = pkg.repository?.match(
          /^https:\/\/github\.com\/([^/]+\/[^/#]+?)(?:\.git)?\/?$/,
        )?.[1];
        let found = 0;
        if (repo && /^[a-f0-9]{40}$/.test(vcs?.git?.sha1 ?? "")) {
          for (
            const file of [
              "LICENSE",
              "LICENSE.md",
              "LICENSE.txt",
              "LICENSE-MIT",
              "LICENSE-APACHE",
              "COPYING",
            ]
          ) {
            const url =
              `https://raw.githubusercontent.com/${repo}/${vcs.git.sha1}/${file}`;
            const response = await fetch(url, {
              signal: AbortSignal.timeout(15000),
            });
            if (response.status === 404) {
              await response.body?.cancel();
              continue;
            }
            requireThat(
              response.ok,
              `Native source notice ${url}: ${response.status}`,
            );
            const bytes = new Uint8Array(await response.arrayBuffer());
            requireThat(bytes.length > 0, `Empty native source notice ${url}`);
            await save(`crate_${name}`, version, url, file, bytes);
            found++;
          }
        }
        if (!found) {
          const ids = !pkg["license-file"] && pkg.license
            ? await standardIds(pkg.license)
            : undefined;
          if (!ids) {
            missing.push({
              name,
              version,
              archive,
              package: metadata.package,
              vcs,
            });
          } else {
            const source =
              `https://static.crates.io/crates/${name}/${name}-${version}.crate#sha256=${checksum}`;
            const declaration =
              contents.includes(`${name}-${version}/Cargo.toml.orig`)
                ? `${name}-${version}/Cargo.toml.orig`
                : cargoPath;
            await command("tar", ["-xOzf", archive, declaration], {
              raw: (bytes) =>
                save(
                  `crate_${name}`,
                  version,
                  `${source}; member=${declaration}`,
                  "UPSTREAM-DECLARATION",
                  bytes,
                  "upstream-declaration",
                ),
            });
            const members = contents.filter((p) => /\.(rs|md|toml)$/.test(p));
            await command("tar", ["-xOzf", archive, ...members], {
              raw: async (bytes) => {
                if (
                  /copyright|permission is hereby granted|licensed under/i.test(
                    new TextDecoder().decode(bytes),
                  )
                ) {
                  await save(
                    `crate_${name}`,
                    version,
                    `${source}; verbatim concatenation of ${members.join(",")}`,
                    "UPSTREAM-SOURCE-NOTICES",
                    bytes,
                    "upstream-source-notices",
                  );
                }
              },
            });
            for (const id of ids) {
              const url = `${spdxRoot}/text/${id}.txt`;
              if (!standardTexts.has(id)) standardTexts.set(id, download(url));
              await save(
                `crate_${name}`,
                version,
                url,
                `STANDARD-TEXT-${id}`,
                await standardTexts.get(id)!,
                "standard-license-text-not-upstream-notice",
              );
            }
          }
        }
        continue;
      }
      for (const path of paths) {
        requireThat(
          !path.split("/").includes("..") && !path.startsWith("/"),
          "Unsafe license archive path",
        );
        await command("tar", ["-xOzf", archive, path], {
          raw: async (bytes) => {
            requireThat(
              bytes.length > 0,
              `Empty native notice ${name}/${path}`,
            );
            await save(
              `crate_${name}`,
              version,
              `https://static.crates.io/crates/${name}/${name}-${version}.crate#sha256=${checksum}`,
              path,
              bytes,
            );
          },
        });
      }
    }
  });
  await Promise.all(workers);
  await Deno.writeTextFile(
    join(work, "missing-license-sources.json"),
    JSON.stringify(missing, null, 2),
  );
  requireThat(
    missing.length === 0,
    `Native license texts unresolved: ${missing.length}; see ${work}/missing-license-sources.json`,
  );
  inventory.sort((a, b) =>
    a.component.localeCompare(b.component) ||
    a.version.localeCompare(b.version) || a.path.localeCompare(b.path)
  );
  await Deno.writeTextFile(
    join(output, "inventory.json"),
    JSON.stringify(inventory, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    join(output, "PROVENANCE.md"),
    "# Notice provenance\n\nThe inventory distinguishes verbatim upstream texts, exact upstream license declarations, preserved inline source notices, and separately supplied standard SPDX license texts. Standard templates are not publisher copyright notices. No attribution or year has been inferred. SPDX texts are pinned to license-list-data commit 8a04f0303d95c4f932210b118588c662665bd383. The native list is a conservative lockfile superset, including unused platform/build/test crates.\n",
  );
  await copyFile(
    join(stage, "LICENSE"),
    join(output, "delta-chat-mcp-LICENSE.txt"),
  );
  return {
    npmPackages: packages.size,
    nativeCrates: crates.size,
    noticeTexts: inventory.length,
  };
}
if (import.meta.main) {
  const work = workspace(argument("--workspace"));
  await Deno.mkdir(work, { mode: 0o700 });
  console.log(
    await notices(
      argument("--stage"),
      work,
      join(work, "licenses"),
      argument("--cache"),
    ),
  );
}
