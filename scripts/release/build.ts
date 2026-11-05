// SPDX-License-Identifier: LGPL-3.0-only
import { join, resolve } from "@std/path";
import {
  argument,
  command,
  copyFile,
  copyTree,
  files,
  record,
  requireThat,
  sha256,
  workspace,
} from "./common.ts";
import { notices } from "./notices.ts";

export async function build(output: string) {
  requireThat(
    Deno.version.deno === "2.9.6",
    "Release build requires Deno 2.9.6",
  );
  requireThat(
    Deno.build.os === "linux" && Deno.build.arch === "x86_64",
    "Only Linux x86_64 is supported",
  );
  workspace(output);
  const source = Deno.cwd();
  requireThat(
    !output.startsWith(`${source}/`) ||
      output.startsWith(`${source}/.test-state/`),
    "Output must be separate or under ignored .test-state",
  );
  await Deno.mkdir(output, { mode: 0o700 });
  const stage = join(output, "source");
  await Deno.mkdir(stage, { mode: 0o755 });
  const version = (await Deno.readTextFile("VERSION")).trim();
  requireThat(/^\d+\.\d+\.\d+$/.test(version), "Invalid release VERSION");
  requireThat(
    (await Deno.readTextFile("CHANGELOG.md")).includes(`## ${version} - `),
    "Missing release changelog",
  );
  for (
    const path of [
      "deno.json",
      "deno.lock",
      "main.ts",
      "LICENSE",
      "THIRD-PARTY-NOTICES.md",
      "VERSION",
      "CHANGELOG.md",
      "README.md",
    ]
  ) {
    await copyFile(path, join(stage, path));
  }
  // No checkout metadata, existing dependencies, local config or mutable state.
  for (const dir of ["src", "defaults", "licenses", "docs", "scripts"]) {
    await copyTree(dir, join(stage, dir));
  }
  for (const dir of ["web", "integrations"]) {
    const allowed = (await files(dir)).filter((p) =>
      !p.split("/").some((s) =>
        ["node_modules", "dist", "tests", ".test-state", ".tmp"].includes(s)
      ) && !["server.js", "worker.js", "hook.js"].includes(p.split("/").at(-1)!)
    );
    for (const file of allowed) {
      await copyFile(join(dir, file), join(stage, dir, file));
    }
  }
  const inputs: Record<string, string> = {};
  for (const path of await files(stage)) {
    inputs[path] = await sha256(await Deno.readFile(join(stage, path)));
  }
  await Deno.writeTextFile(
    join(output, "source-manifest.json"),
    JSON.stringify(inputs, null, 2) + "\n",
  );
  const deno = (args: string[], log: string, ms = 180000) =>
    command(Deno.execPath(), args, { cwd: stage, ms, log: join(output, log) });
  record("frozen-install");
  await deno(["install", "--frozen"], "install.log");
  for (const task of ["build:web", "build:opencode", "build:conversations"]) {
    await deno(["task", task], `${task.replaceAll(":", "-")}.log`);
  }
  // Expose the exact built bytes to the documented smoke --assets web/dist.
  await copyTree(join(stage, "web/dist"), join(source, "web/dist"));
  record("bundles-built");
  const licensing = await notices(stage, join(output, "notice-inputs"));
  record("notices-collected", licensing);
  const native = join(
    stage,
    "node_modules/.deno/@deltachat+stdio-rpc-server-linux-x64@2.65.0/node_modules/@deltachat/stdio-rpc-server-linux-x64/deltachat-rpc-server",
  );
  requireThat(
    (await Deno.stat(native)).mode! & 0o111,
    "Pinned native core executable missing",
  );
  await Deno.mkdir(join(output, "bin"), { mode: 0o755 });
  const binary = join(output, "bin/delta-chat-mcp");
  await deno(
    [
      "compile",
      "--frozen-lockfile",
      "--self-extracting",
      "--target",
      "x86_64-unknown-linux-gnu",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "--include",
      "src/http/routes/",
      "--include",
      "defaults/",
      "--include",
      "web/dist/",
      "--include",
      "LICENSE",
      "--include",
      "THIRD-PARTY-NOTICES.md",
      "--include",
      "licenses/",
      "--output",
      binary,
      "main.ts",
    ],
    "compile.log",
    300000,
  );
  const abi = await command("readelf", ["-l", "-d", "-V", binary]);
  await Deno.writeTextFile(join(output, "ABI.txt"), abi + "\n");
  const glibc = [...abi.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((
    m,
  ) => [Number(m[1]), Number(m[2])]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .at(-1);
  requireThat(glibc, "Unable to measure glibc ABI");
  const provenance = {
    version,
    deno: Deno.version.deno,
    nativeCore: "2.65.0",
    target: "x86_64-unknown-linux-gnu",
    sourceTree: Deno.env.get("RELEASE_SOURCE_TREE") ??
      "uncommitted-source-manifest",
    sourceManifestSha256: await sha256(
      await Deno.readFile(join(output, "source-manifest.json")),
    ),
    binarySha256: await sha256(await Deno.readFile(binary)),
    nativeCoreSha256: await sha256(await Deno.readFile(native)),
    glibc: glibc.join("."),
    licenses: licensing,
  };
  const resources: Record<string, string> = {};
  for (const dir of ["web/dist", "defaults", "src/http/routes"]) {
    for (const path of await files(join(stage, dir))) {
      resources[join(dir, path)] = await sha256(
        await Deno.readFile(join(stage, dir, path)),
      );
    }
  }
  await Deno.writeTextFile(
    join(output, "resource-manifest.json"),
    JSON.stringify(resources, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    join(output, "PROVENANCE.json"),
    JSON.stringify(provenance, null, 2) + "\n",
  );
  const serviceName = `delta-chat-mcp-${version}-linux-x86_64`;
  const integrationName = `delta-chat-mcp-${version}-integrations`;
  const archives = join(output, "archives");
  await Deno.mkdir(archives);
  const service = join(archives, serviceName),
    integration = join(archives, integrationName);
  await Deno.mkdir(service);
  await Deno.mkdir(integration);
  await copyFile(binary, join(service, "delta-chat-mcp"));
  for (const dst of [service, integration]) {
    for (const path of ["LICENSE", "THIRD-PARTY-NOTICES.md", "VERSION"]) {
      await copyFile(join(stage, path), join(dst, path));
    }
    await copyTree(join(stage, "licenses"), join(dst, "licenses"));
    await copyFile(join(stage, "docs/release.md"), join(dst, "RUN.md"));
    await copyFile(
      join(output, "PROVENANCE.json"),
      join(dst, "PROVENANCE.json"),
    );
  }
  await copyFile(join(output, "ABI.txt"), join(service, "ABI.txt"));
  await copyFile(
    join(output, "resource-manifest.json"),
    join(service, "resource-manifest.json"),
  );
  for (const path of ["README.md", "docs/conversations.md"]) {
    await copyFile(join(stage, path), join(integration, path));
  }
  for (
    const path of [
      "integrations/opencode/dist/delta-chat-mcp-opencode.js",
      "integrations/opencode-v2/server.js",
      "integrations/opencode-v2/package.json",
      "integrations/claude-code/worker.js",
      "integrations/claude-code/hook.js",
      "integrations/claude-code/.mcp.json",
      "integrations/claude-code/.claude-plugin/plugin.json",
      "integrations/claude-code/hooks/hooks.json",
    ]
  ) await copyFile(join(stage, path), join(integration, path));
  const sums: string[] = [];
  for (const name of [serviceName, integrationName]) {
    const file = `${name}.tar.gz`;
    await command("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      join(output, file),
      "-C",
      archives,
      name,
    ], { ms: 180000 });
    const contents = await command("tar", ["-tzf", join(output, file)]);
    requireThat(
      !contents.split("\n").some((p) =>
        /(^|\/)(node_modules|data|accounts|\.envrc|\.test-state|config\.json|auth\.toml)(\/|$)/
          .test(p)
      ),
      "Private or dependency directory in archive",
    );
    await Deno.writeTextFile(
      join(output, `${file}.contents.txt`),
      contents + "\n",
    );
    sums.push(
      `${await sha256(await Deno.readFile(join(output, file)))}  ${file}`,
    );
  }
  await Deno.writeTextFile(join(output, "SHA256SUMS"), sums.join("\n") + "\n");
  record("release-built", provenance);
}
if (import.meta.main) await build(resolve(argument("--output")));
