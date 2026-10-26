// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { healthUrl, waitReady } from "../../deploy/check-ready.ts";
import { fixture } from "../support.ts";

const installer = new URL("../../deploy/install.sh", import.meta.url).pathname;
async function shell(code: string, root: string) {
  return await new Deno.Command("bash", {
    args: ["-euo", "pipefail", "-c", `source "$INSTALLER"; ${code}`],
    env: { INSTALLER: installer, TEST_ROOT: root },
    stdout: "piped",
    stderr: "piped",
  }).output();
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

Deno.test("verified ZIP runtime remains traversable and executable under umask077", async () => {
  const root = await fixture("m4-runtime-modes");
  await Deno.mkdir(`${root}/download`);
  const archive = `${root}/download/deno-x86_64-unknown-linux-gnu.zip`;
  const zip = await new Deno.Command("python3", {
    args: [
      "-c",
      `import sys,zipfile
entry=zipfile.ZipInfo("deno")
entry.create_system=3
entry.external_attr=0o100755 << 16
with zipfile.ZipFile(sys.argv[1],"w") as output:
 output.writestr(entry,b"#!/bin/bash\\nprintf 'deno 2.9.6 (stable, release, x86_64-unknown-linux-gnu)\\\\n'\\n")`,
      archive,
    ],
  }).output();
  assertEquals(zip.code, 0, text(zip.stderr));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(archive),
  );
  const checksum = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  await Deno.writeTextFile(
    `${archive}.sha256sum`,
    `${checksum}  deno-x86_64-unknown-linux-gnu.zip\n`,
  );
  const result = await shell(
    `
umask 077
transaction="$TEST_ROOT/transaction"
mkdir "$transaction"; chmod 0755 "$transaction"
curl() {
  local value remote
  for value in "$@"; do if [[ $value == https://* ]]; then remote=${"${value##*/}"}; fi; done
  cp "$TEST_ROOT/download/$remote" "${"${*: -1}"}"
}
download_deno
`,
    root,
  );
  assertEquals(result.code, 0, text(result.stderr));
  assertEquals(
    (await Deno.stat(`${root}/transaction/runtime`)).mode! & 0o777,
    0o755,
  );
  assertEquals(
    (await Deno.stat(`${root}/transaction/runtime/deno`)).mode! & 0o777,
    0o755,
  );
});

Deno.test("allowlisted source permission boundary ignores restrictive extraction modes", async () => {
  const root = await fixture("m4-source-modes");
  const source = `${root}/source`;
  for (const dir of ["src", "defaults", "web/src", "deploy"]) {
    await Deno.mkdir(`${source}/${dir}`, { recursive: true, mode: 0o700 });
  }
  for (
    const name of [
      "LICENSE",
      "main.ts",
      "deno.json",
      "deno.lock",
      "defaults/config.toml",
      "defaults/public-relays.json",
      "src/module.ts",
      "web/src/view.tsx",
      "web/index.html",
      "web/vite.config.ts",
      "deploy/install.sh",
      "deploy/uninstall.sh",
      "deploy/check-ready.ts",
      "deploy/delta-chat-mcp.service",
    ]
  ) {
    await Deno.writeTextFile(`${source}/${name}`, "fixture", { mode: 0o600 });
  }
  await Deno.writeTextFile(`${source}/src/tool`, "executable", { mode: 0o700 });
  await Deno.mkdir(`${root}/candidate`);
  const result = await shell(
    'umask 077; source_dir="$TEST_ROOT/source"; candidate="$TEST_ROOT/candidate"; source_check; copy_source',
    root,
  );
  assertEquals(result.code, 0, text(result.stderr));
  for (const name of ["src", "defaults", "web/src", "deploy"]) {
    assertEquals(
      (await Deno.stat(`${root}/candidate/${name}`)).mode! & 0o777,
      0o755,
      name,
    );
  }
  for (
    const name of [
      "main.ts",
      "src/module.ts",
      "web/src/view.tsx",
      "defaults/public-relays.json",
    ]
  ) {
    assertEquals(
      (await Deno.stat(`${root}/candidate/${name}`)).mode! & 0o777,
      0o644,
      name,
    );
  }
  assertEquals(
    (await Deno.stat(`${root}/candidate/src/tool`)).mode! & 0o777,
    0o755,
  );
});

Deno.test("sealing generated output permits nonowner reads without losing native executable bits", async () => {
  const root = await fixture("m4-seal-modes");
  const result = await shell(
    `
umask 077
candidate="$TEST_ROOT/candidate"; transaction="$TEST_ROOT/transaction"
mkdir -p "$candidate/web" "$transaction/runtime"
chgrp() { return 0; }
chown() { return 0; }
install() { command install -d -m 0755 "${"${@: -2}"}"; }
as_service() {
  printf asset > "$candidate/web/dist/index.html"
  printf font > "$candidate/web/dist/font.woff2"
  printf core > "$candidate/node_modules/native-tool"
  chmod 0700 "$candidate/node_modules/native-tool"
}
build_candidate
`,
    root,
  );
  assertEquals(result.code, 0, text(result.stderr));
  assertEquals(
    (await Deno.stat(`${root}/candidate/web/dist/index.html`)).mode! & 0o777,
    0o644,
  );
  assertEquals(
    (await Deno.stat(`${root}/candidate/web/dist/font.woff2`)).mode! & 0o777,
    0o644,
  );
  assertEquals(
    (await Deno.stat(`${root}/candidate/node_modules/native-tool`)).mode! &
      0o777,
    0o755,
  );
});

Deno.test("systemd runtime permissions exactly match the start task; unprivileged lifetime and disk scratch", async () => {
  const config = JSON.parse(await Deno.readTextFile("deno.json"));
  const unit = await Deno.readTextFile("deploy/delta-chat-mcp.service");
  const start = unit.split("\n").find((line) => line.startsWith("ExecStart="))!;
  assertEquals(
    start,
    `ExecStart=/usr/local/bin/${
      config.tasks.start.replace(/main.ts$/, "/opt/delta-chat-mcp/main.ts")
    }`,
  );
  for (
    const line of [
      "User=delta-chat-mcp",
      "Group=delta-chat-mcp",
      "WorkingDirectory=/opt/delta-chat-mcp",
      "Environment=DCMCP_DATA_DIR=/var/lib/delta-chat-mcp",
      "Environment=DENO_DIR=/var/cache/delta-chat-mcp/deno",
      "Environment=TMPDIR=/var/cache/delta-chat-mcp/tmp",
      "EnvironmentFile=-/etc/delta-chat-mcp/env",
      "Restart=on-failure",
      "TimeoutStopSec=30",
      "NoNewPrivileges=yes",
      "KillMode=control-group",
    ]
  ) assert(unit.split("\n").includes(line), line);
});

Deno.test("deployment admission rejects nonroot before mutation and purge rejects noninteractive input", async () => {
  const root = await fixture("m4-admission");
  const result = await shell("platform_check", root);
  assertEquals(result.code, 1);
  assert(text(result.stderr).includes("Run this installer as root"));
  const purge = await new Deno.Command("bash", {
    args: [
      "-c",
      'source deploy/uninstall.sh; id() { printf "0\\n"; }; main --purge',
    ],
    stdin: "null",
    stderr: "piped",
  }).output();
  assertEquals(purge.code, 1);
  assert(text(purge.stderr).includes("interactive confirmation"));
});

Deno.test("deployment source allowlist excludes credentials, runtime, test fixtures and builds", async () => {
  const root = await fixture("m4-source");
  const source = `${root}/source`;
  for (
    const dir of [
      "src",
      "web/src",
      "defaults",
      "deploy",
      "data",
      "artifacts",
      ".git",
      "web/dist",
      "node_modules",
      ".test-state",
    ]
  ) {
    await Deno.mkdir(`${source}/${dir}`, { recursive: true });
  }
  for (
    const name of [
      "LICENSE",
      "main.ts",
      "deno.json",
      "deno.lock",
      "defaults/config.toml",
      "src/ok.ts",
      "web/index.html",
      "web/src/ok.tsx",
      "web/vite.config.ts",
      "deploy/install.sh",
      "deploy/uninstall.sh",
      "deploy/check-ready.ts",
      "deploy/delta-chat-mcp.service",
      ".env",
      "src/.env.local",
      "src/private.key",
      "web/src/.env",
      "data/auth.toml",
      "artifacts/secret",
      ".git/config",
      "node_modules/old",
      "web/dist/old",
      ".test-state/identity",
    ]
  ) await Deno.writeTextFile(`${source}/${name}`, name);
  await Deno.mkdir(`${root}/candidate`);
  const result = await shell(
    'source_dir="$TEST_ROOT/source"; candidate="$TEST_ROOT/candidate"; source_check; copy_source',
    root,
  );
  assertEquals(result.code, 0, text(result.stderr));
  assertEquals(
    await Deno.readTextFile(`${root}/candidate/src/ok.ts`),
    "src/ok.ts",
  );
  for (
    const name of [
      "data",
      "artifacts",
      ".git",
      ".test-state",
      "node_modules",
      "web/dist",
      ".env",
      "src/.env.local",
      "src/private.key",
      "web/src/.env",
    ]
  ) {
    await assertRejects(
      () => Deno.stat(`${root}/candidate/${name}`),
      Deno.errors.NotFound,
    );
  }
  await Deno.rename(`${source}/deno.lock`, `${source}/original-lock`);
  await Deno.symlink("original-lock", `${source}/deno.lock`);
  assertEquals(
    (await shell('source_dir="$TEST_ROOT/source"; source_check', root)).code,
    1,
  );
});

const transactionSetup = `
app="$TEST_ROOT/app"; unit="$TEST_ROOT/unit"; deno_bin="$TEST_ROOT/deno"
transaction="$TEST_ROOT/transaction"; candidate="$transaction/candidate"
mkdir -p "$app" "$candidate/deploy" "$transaction/runtime" "$TEST_ROOT/state" "$TEST_ROOT/config"
printf old > "$app/version"; printf old-unit > "$unit"; printf old-deno > "$deno_bin"
printf new > "$candidate/version"; printf new-unit > "$candidate/deploy/delta-chat-mcp.service"
printf new-deno > "$transaction/runtime/deno"
printf identity-history-auth-key > "$TEST_ROOT/state/preserved"
printf operator-config > "$TEST_ROOT/config/preserved"
activation=preparing; app_swapped=no
systemctl() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/systemctl.log"
  if [[ $1 == restart && ${"${FAIL_RESTART:-no}"} == yes ]]; then return 1; fi
  return 0
}
trap rollback EXIT
`;

Deno.test("upgrade stages candidate then admits new release without changing state/config", async () => {
  const root = await fixture("m4-upgrade");
  const result = await shell(
    transactionSetup + "\nactivate; trap - EXIT",
    root,
  );
  assertEquals(result.code, 0, text(result.stderr));
  assertEquals(await Deno.readTextFile(`${root}/app/version`), "new");
  assertEquals(await Deno.readTextFile(`${root}/unit`), "new-unit");
  assertEquals(await Deno.readTextFile(`${root}/deno`), "new-deno");
  assertEquals(
    await Deno.readTextFile(`${root}/transaction/previous-app/version`),
    "old",
  );
  assertEquals(
    await Deno.readTextFile(`${root}/state/preserved`),
    "identity-history-auth-key",
  );
  assertEquals(
    await Deno.readTextFile(`${root}/config/preserved`),
    "operator-config",
  );
  const log = await Deno.readTextFile(`${root}/systemctl.log`);
  assert(
    log.indexOf("stop delta-chat-mcp") < log.indexOf("restart delta-chat-mcp"),
  );
});

Deno.test("failed activation restores old app/runtime/unit and restarts previous service, preserving state", async () => {
  const root = await fixture("m4-rollback");
  const result = await shell(
    transactionSetup + "\nFAIL_RESTART=yes; activate",
    root,
  );
  assertEquals(result.code, 1);
  assert(text(result.stderr).includes("previous app/runtime/unit restored"));
  assertEquals(await Deno.readTextFile(`${root}/app/version`), "old");
  assertEquals(await Deno.readTextFile(`${root}/unit`), "old-unit");
  assertEquals(await Deno.readTextFile(`${root}/deno`), "old-deno");
  assertEquals(
    await Deno.readTextFile(`${root}/transaction/failed-app/version`),
    "new",
  );
  assertEquals(
    await Deno.readTextFile(`${root}/state/preserved`),
    "identity-history-auth-key",
  );
  assertEquals(
    await Deno.readTextFile(`${root}/config/preserved`),
    "operator-config",
  );
  assert(
    (await Deno.readTextFile(`${root}/systemctl.log`)).endsWith(
      "start delta-chat-mcp\n",
    ),
  );
});

Deno.test("preparation failure does not stop or replace running release", async () => {
  const root = await fixture("m4-prepare-failure");
  const result = await shell(transactionSetup + "\nfalse", root);
  assertEquals(result.code, 1);
  assertEquals(await Deno.readTextFile(`${root}/app/version`), "old");
  await assertRejects(
    () => Deno.stat(`${root}/systemctl.log`),
    Deno.errors.NotFound,
  );
});

Deno.test("failed activation preserves disabled state and fresh-install failure leaves no admitted app", async () => {
  const disabled = await fixture("m4-disabled-rollback");
  const result = await shell(
    transactionSetup + `
systemctl() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/systemctl.log"
  case $1 in is-active|is-enabled|restart) return 1 ;; esac
}
activate
`,
    disabled,
  );
  assertEquals(result.code, 1);
  assertEquals(await Deno.readTextFile(`${disabled}/app/version`), "old");
  const log = await Deno.readTextFile(`${disabled}/systemctl.log`);
  assert(log.includes("disable delta-chat-mcp\n"));
  assert(!log.split("\n").includes("start delta-chat-mcp"));
  const fresh = await fixture("m4-fresh-rollback");
  const clean = await shell(
    transactionSetup + `
mv "$app" "$TEST_ROOT/unrelated-retained-app"
mv "$unit" "$TEST_ROOT/unrelated-retained-unit"
mv "$deno_bin" "$TEST_ROOT/unrelated-retained-deno"
systemctl() { case $1 in is-active|is-enabled|restart) return 1 ;; disable) test -f "$unit" ;; esac; }
activate
`,
    fresh,
  );
  assertEquals(clean.code, 1);
  assert(
    text(clean.stderr).includes("Installer failed; retained transaction:"),
  );
  for (const name of ["app", "unit", "deno"]) {
    await assertRejects(
      () => Deno.stat(`${fresh}/${name}`),
      Deno.errors.NotFound,
    );
  }
  assertEquals(
    await Deno.readTextFile(`${fresh}/transaction/failed-app/version`),
    "new",
  );
  assertEquals(
    await Deno.readTextFile(`${fresh}/state/preserved`),
    "identity-history-auth-key",
  );
});

Deno.test("runtime admission accepts official stable version banner and rejects other versions", async () => {
  const root = await fixture("m4-version");
  const binary = `${root}/deno`;
  for (
    const [version, code] of [["2.9.6", 0], ["2.9.60", 1], [
      "2.9.5",
      1,
    ]] as const
  ) {
    await Deno.writeTextFile(
      binary,
      `#!/bin/bash\nprintf 'deno ${version} (stable, release, x86_64-unknown-linux-gnu)\\nv8 example\\n'\n`,
      { mode: 0o755 },
    );
    assertEquals(
      (await shell('verify_runtime "$TEST_ROOT/deno"', root)).code,
      code,
    );
  }
});

Deno.test("published checksum mismatch prevents extracting or running downloaded archive", async () => {
  const root = await fixture("m4-checksum");
  const result = await shell(
    `
transaction="$TEST_ROOT"
curl() { local out="${"${*: -1}"}"; if [[ $out == *.sha256sum ]]; then printf '%064d  deno-x86_64-unknown-linux-gnu.zip\\n' 0 > "$out"; else printf tampered > "$out"; fi; }
unzip() { touch "$TEST_ROOT/extracted"; }
download_deno
`,
    root,
  );
  assert(result.code !== 0);
  await assertRejects(
    () => Deno.stat(`${root}/extracted`),
    Deno.errors.NotFound,
  );
});

Deno.test("deployment health admission honours listener and waits for actual core readiness", async () => {
  assertEquals(
    healthUrl({ hostname: "0.0.0.0", port: 8080 }),
    "http://127.0.0.1:8080/_/health",
  );
  assertEquals(
    healthUrl({ hostname: "::", port: 8181 }),
    "http://[::1]:8181/_/health",
  );
  assertEquals(
    healthUrl({ hostname: "10.4.10.129", port: 8181 }),
    "http://10.4.10.129:8181/_/health",
  );
  let polls = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      Response.json({ ok: true, core: ++polls < 3 ? "restarting" : "ready" }),
  );
  try {
    await waitReady(`http://127.0.0.1:${server.addr.port}/_/health`, 2000);
    assertEquals(polls, 3);
  } finally {
    await server.shutdown();
  }
});
