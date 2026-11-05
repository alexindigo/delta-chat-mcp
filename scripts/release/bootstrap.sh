#!/bin/sh
set -eu
test "${RUNNER_ENVIRONMENT-}" = github-hosted
test "${RUNNER_OS-}" = Linux
test "${RUNNER_ARCH-}" = X64
test -n "${GITHUB_WORKSPACE-}"
export TMPDIR="$GITHUB_WORKSPACE/.test-state/release/tmp"
export DENO_DIR="$GITHUB_WORKSPACE/.test-state/release/deno"
tools="$GITHUB_WORKSPACE/.test-state/release/tools"
mkdir -p "$TMPDIR" "$DENO_DIR" "$tools"
timeout 120 curl --fail --location --max-time 115 --output "$tools/deno.zip" https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-unknown-linux-gnu.zip
printf '%s  %s\n' 394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2 "$tools/deno.zip" | timeout 15 sha256sum --check -
timeout 30 unzip -o "$tools/deno.zip" -d "$tools"
printf '%s\n' "$tools" >> "$GITHUB_PATH"
timeout 10 "$tools/deno" --version
