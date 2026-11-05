// SPDX-License-Identifier: LGPL-3.0-only
import { join, resolve } from "@std/path";
import {
  argument,
  command,
  record,
  requireThat,
  sha256,
  workspace,
} from "./common.ts";
import { metadata } from "./metadata.ts";
import { githubVm } from "./ci.ts";

const repository = "alexindigo/delta-chat-mcp";
const image = `ghcr.io/${repository}`;
const accept =
  "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
async function registryToken(authenticated: boolean) {
  const headers: Record<string, string> = {};
  if (authenticated) {
    const token = Deno.env.get("GH_TOKEN"),
      actor = Deno.env.get("GITHUB_ACTOR");
    requireThat(token && actor, "Publishing credentials unavailable");
    headers.Authorization = `Basic ${btoa(`${actor}:${token}`)}`;
  }
  const response = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
    { headers, signal: AbortSignal.timeout(15000) },
  );
  requireThat(
    response.ok,
    `Registry token HTTP ${response.status}, anonymous=${!authenticated}`,
  );
  const body = await response.json();
  requireThat(typeof body.token === "string", "Registry token absent");
  return body.token as string;
}
async function manifest(tag: string, token: string) {
  return await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
    signal: AbortSignal.timeout(15000),
  });
}
async function publish() {
  githubVm();
  const out = workspace(resolve(argument("--output")));
  const qualified = JSON.parse(
    await Deno.readTextFile(join(out, "qualification.json")),
  );
  requireThat(qualified.passed === true, "Qualification missing");
  requireThat(
    await command("git", ["rev-parse", "HEAD"]) === qualified.sourceCommit,
    "Qualification source differs",
  );
  requireThat(
    await command("git", ["rev-parse", "HEAD^{tree}"]) === qualified.sourceTree,
    "Qualification tree differs",
  );
  for (const [name, hash] of Object.entries(qualified.hashes)) {
    requireThat(
      !name.includes("/") &&
        await sha256(await Deno.readFile(join(out, name))) === hash,
      `Qualified artifact checksum ${name}`,
    );
  }
  const meta = await metadata(Deno.env.get("GITHUB_REF_NAME"));
  await command("docker", ["load", "--input", join(out, "image.tar")], {
    ms: 180000,
  });
  const id = await command("docker", [
    "image",
    "inspect",
    "delta-chat-mcp:smoke",
    "--format",
    "{{.Id}}",
  ]);
  requireThat(id === qualified.image, "Loaded image is not the tested image");
  const token = await registryToken(true);
  const existing = await manifest(meta.version, token);
  let versionExists = false;
  if (existing.status === 200) {
    requireThat(
      (await existing.json()).config?.digest === id,
      "Immutable version already points to another image",
    );
    versionExists = true; // Preserve the public version ref; never push it again.
  } else {
    requireThat(
      existing.status === 404,
      `Cannot establish version absence: HTTP ${existing.status}`,
    );
    await existing.body?.cancel();
  }
  const notes = join(out, "release-notes.md");
  await Deno.writeTextFile(notes, meta.notes + "\n");
  // An existing/uncertain release fails visibly; retries require observed-state
  // recovery rather than replaying side effects or replacing an immutable tag.
  await command("gh", [
    "release",
    "create",
    meta.tag,
    "--repo",
    repository,
    "--verify-tag",
    "--draft",
    "--title",
    meta.tag,
    "--notes-file",
    notes,
    join(out, `delta-chat-mcp-${meta.version}-linux-x86_64.tar.gz`),
    join(out, `delta-chat-mcp-${meta.version}-integrations.tar.gz`),
    join(out, "SHA256SUMS"),
  ], { ms: 180000 });
  for (const alias of meta.aliases) {
    if (alias === meta.version && versionExists) continue;
    await command("docker", ["tag", id, `${image}:${alias}`]);
    await command("docker", ["push", `${image}:${alias}`], { ms: 180000 });
  }
  await command("gh", [
    "release",
    "edit",
    meta.tag,
    "--repo",
    repository,
    "--draft=false",
    `--latest=${meta.aliases.includes("latest")}`,
  ]);
  const anonymous = await registryToken(false);
  const digests: Record<string, string> = {};
  for (const alias of meta.aliases) {
    const response = await manifest(alias, anonymous);
    requireThat(
      response.ok,
      `Anonymous ${alias} manifest HTTP ${response.status}; package visibility may require owner action`,
    );
    const digest = response.headers.get("docker-content-digest");
    requireThat(
      digest && (await response.json()).config?.digest === id,
      `Published ${alias} image differs`,
    );
    digests[alias] = digest;
  }
  requireThat(
    new Set(Object.values(digests)).size === 1,
    "Public alias digests disagree",
  );
  for (
    const name of [
      `delta-chat-mcp-${meta.version}-linux-x86_64.tar.gz`,
      `delta-chat-mcp-${meta.version}-integrations.tar.gz`,
      "SHA256SUMS",
    ]
  ) {
    const response = await fetch(
      `https://github.com/${repository}/releases/download/${meta.tag}/${name}`,
      { signal: AbortSignal.timeout(180000) },
    );
    requireThat(
      response.ok,
      `Anonymous download ${name}: HTTP ${response.status}`,
    );
    requireThat(
      await sha256(new Uint8Array(await response.arrayBuffer())) ===
        qualified.hashes[name],
      `Public download checksum ${name}`,
    );
  }
  const credentials = join(out, "anonymous-docker");
  await Deno.mkdir(credentials, { mode: 0o700 });
  Deno.env.set("DOCKER_CONFIG", credentials);
  await command("docker", ["pull", `${image}:${meta.version}`], { ms: 180000 });
  const assets = join(out, "public-assets");
  await Deno.mkdir(assets);
  await command("tar", ["-xzf", join(out, "web-assets.tar.gz"), "-C", assets]);
  await command(Deno.execPath(), [
    "run",
    "-A",
    "scripts/release/smoke.ts",
    "--image",
    `${image}:${meta.version}`,
    "--assets",
    join(assets, "web/dist"),
    "--workspace",
    join(out, "public-image-smoke"),
  ], { ms: 900000 });
  await Deno.writeTextFile(
    join(out, "public-verification.json"),
    JSON.stringify(
      {
        passed: true,
        source: qualified.sourceCommit,
        image: id,
        digests,
        anonymousDownloadsVerified: true,
        anonymousPulledImageSmoke: true,
      },
      null,
      2,
    ),
  );
  record("public-release-verified", { tag: meta.tag, image: id, digests });
}
if (import.meta.main) await publish();
