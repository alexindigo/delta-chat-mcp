// SPDX-License-Identifier: LGPL-3.0-only
import { join, resolve } from "@std/path";
import {
  argument,
  command,
  copyFile,
  record,
  requireThat,
  sha256,
  workspace,
} from "./common.ts";
import { metadata } from "./metadata.ts";

export function githubVm() {
  requireThat(
    Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted" &&
      Deno.env.get("RUNNER_OS") === "Linux" &&
      Deno.env.get("RUNNER_ARCH") === "X64",
    "Only named GitHub-hosted Linux/X64 VM jobs may run this driver",
  );
  record("github-vm", {
    hostname: Deno.hostname(),
    job: Deno.env.get("GITHUB_JOB"),
    run: Deno.env.get("GITHUB_RUN_ID"),
    workspace: Deno.cwd(),
    tmpdir: Deno.env.get("TMPDIR"),
  });
}
async function ci() {
  githubVm();
  const out = workspace(resolve(argument("--output")));
  const root = Deno.cwd();
  const meta = await metadata(
    Deno.env.get("GITHUB_REF_TYPE") === "tag"
      ? Deno.env.get("GITHUB_REF_NAME")
      : undefined,
  );
  const sourceTree = await command("git", ["rev-parse", "HEAD^{tree}"]);
  const sourceCommit = await command("git", ["rev-parse", "HEAD"]);
  Deno.env.set("RELEASE_SOURCE_TREE", sourceTree);
  const deno = (args: string[], log: string, ms: number) =>
    command(Deno.execPath(), args, {
      ms,
      log: join(root, ".test-state/release", log),
    });
  await deno(
    ["run", "-A", "scripts/release/build.ts", "--output", out],
    "build.log",
    1200000,
  );
  await deno(
    [
      "fmt",
      "--check",
      "scripts/release/",
      "VERSION",
      "CHANGELOG.md",
      "THIRD-PARTY-NOTICES.md",
      "docs/release.md",
      "README.md",
      ".github/workflows/",
    ],
    "fmt.log",
    120000,
  );
  await deno(["lint", "scripts/release/"], "lint.log", 120000);
  await deno(["check", "scripts/release/"], "check.log", 180000);
  await deno(["task", "check"], "project-check.log", 180000);
  await deno(
    [
      "test",
      "-A",
      "scripts/release/contracts_test.ts",
      "tests/unit/config_test.ts",
      "tests/unit/auth_test.ts",
      "tests/unit/keys_static_test.ts",
      "tests/unit/standard_mcp_test.ts",
    ],
    "portable-tests.log",
    180000,
  );
  // Prove the archives deliver the same executable and complete descriptors.
  const unpack = join(out, "unpacked");
  await Deno.mkdir(unpack);
  for (const suffix of ["linux-x86_64", "integrations"]) {
    await command("tar", [
      "-xzf",
      join(out, `delta-chat-mcp-${meta.version}-${suffix}.tar.gz`),
      "-C",
      unpack,
    ]);
  }
  const binary = join(
    unpack,
    `delta-chat-mcp-${meta.version}-linux-x86_64/delta-chat-mcp`,
  );
  requireThat(
    await sha256(await Deno.readFile(binary)) ===
      await sha256(await Deno.readFile(join(out, "bin/delta-chat-mcp"))),
    "Archived executable differs from qualified build",
  );
  for (
    const file of [
      "opencode/dist/delta-chat-mcp-opencode.js",
      "opencode-v2/server.js",
      "opencode-v2/package.json",
      "claude-code/worker.js",
      "claude-code/hook.js",
      "claude-code/.mcp.json",
      "claude-code/.claude-plugin/plugin.json",
      "claude-code/hooks/hooks.json",
    ]
  ) {
    requireThat(
      (await Deno.stat(
        join(
          unpack,
          `delta-chat-mcp-${meta.version}-integrations/integrations`,
          file,
        ),
      )).size > 0,
      `Missing integration ${file}`,
    );
  }
  await deno(
    [
      "run",
      "-A",
      "scripts/release/smoke.ts",
      "--binary",
      binary,
      "--assets",
      "web/dist",
      "--workspace",
      join(out, "smoke-binary"),
    ],
    "smoke-binary.log",
    600000,
  );
  await deno(
    [
      "run",
      "-A",
      "scripts/release/online.ts",
      "--binary",
      binary,
      "--workspace",
      join(out, "online-binary"),
    ],
    "online-binary.log",
    900000,
  );
  await command("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "--tag",
    "delta-chat-mcp:smoke",
    ".",
  ], { ms: 1200000, log: join(root, ".test-state/release/docker-build.log") });
  const image = (await command("docker", [
    "image",
    "inspect",
    "delta-chat-mcp:smoke",
    "--format",
    "{{.Id}}",
  ])).trim();
  await deno(
    [
      "run",
      "-A",
      "scripts/release/smoke.ts",
      "--image",
      "delta-chat-mcp:smoke",
      "--assets",
      "web/dist",
      "--workspace",
      join(out, "smoke-image"),
    ],
    "smoke-image.log",
    900000,
  );
  await deno(
    [
      "run",
      "-A",
      "scripts/release/online.ts",
      "--image",
      "delta-chat-mcp:smoke",
      "--workspace",
      join(out, "online-image"),
    ],
    "online-image.log",
    900000,
  );
  const delivery = join(out, "delivery");
  await Deno.mkdir(delivery);
  for (
    const name of [
      `delta-chat-mcp-${meta.version}-linux-x86_64.tar.gz`,
      `delta-chat-mcp-${meta.version}-integrations.tar.gz`,
      "SHA256SUMS",
      "ABI.txt",
      "PROVENANCE.json",
    ]
  ) await copyFile(join(out, name), join(delivery, name));
  await command("tar", [
    "-czf",
    join(delivery, "web-assets.tar.gz"),
    "-C",
    root,
    "web/dist",
  ]);
  await command("docker", [
    "save",
    "--output",
    join(delivery, "image.tar"),
    "delta-chat-mcp:smoke",
  ], { ms: 180000 });
  const hashes: Record<string, string> = {};
  for await (const file of Deno.readDir(delivery)) {
    hashes[file.name] = await sha256(
      await Deno.readFile(join(delivery, file.name)),
    );
  }
  const result = {
    passed: true,
    sourceCommit,
    sourceTree,
    image,
    metadata: meta,
    hashes,
    runner: Deno.hostname(),
    run: Deno.env.get("GITHUB_RUN_ID"),
  };
  await Deno.writeTextFile(
    join(delivery, "qualification.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  record("release-qualified", result);
}
if (import.meta.main) await ci();
