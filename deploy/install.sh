#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-only
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }

normalize_public_artifacts() {
  # Only allowlisted code/runtime/build output enters this boundary. Never use
  # it on state, operator config, caches or scratch. X retains native/tool
  # executability while making directories traversable and ordinary files read-only
  # to nonowners, independent of extraction modes or the invoking root's umask.
  chmod -R u=rwX,go=rX,u-s,g-s,o-t "$1"
}

platform_check() {
  test "$(id -u)" = 0 || die 'Run this installer as root inside the Debian 13 LXC.'
  # Debian supplies these variables at runtime, not in the source checkout.
  # shellcheck source=/dev/null
  . /etc/os-release
  if [[ $ID != debian || $VERSION_ID != 13 ]]; then die 'Debian 13 is required.'; fi
  test "$(uname -m)" = x86_64 || die 'Linux x86_64 is required.'
}

source_check() {
  local file
  for file in LICENSE main.ts deno.json deno.lock defaults/config.toml web/index.html \
    web/vite.config.ts deploy/install.sh deploy/uninstall.sh deploy/check-ready.ts deploy/delta-chat-mcp.service; do
    if [[ ! -f $source_dir/$file || -L $source_dir/$file ]]; then die "Missing regular source file: $file"; fi
  done
  for file in src web/src; do
    if [[ ! -d $source_dir/$file || -L $source_dir/$file ]]; then die "Missing source directory: $file"; fi
  done
}

copy_source() {
  # Allowlisted inputs: never metadata, state, fixtures, local env or old builds.
  rsync -a --safe-links --exclude='.env*' --exclude='*.pem' --exclude='*.key' \
    --exclude=node_modules --exclude=data --exclude=.tmp --exclude=.test-state \
    --exclude=artifacts --exclude=dist \
    "$source_dir/LICENSE" "$source_dir/main.ts" "$source_dir/deno.json" "$source_dir/deno.lock" \
    "$source_dir/src" "$source_dir/defaults" "$candidate/"
  install -d -m 0755 "$candidate/web" "$candidate/deploy"
  rsync -a --safe-links --exclude='.env*' --exclude='*.pem' --exclude='*.key' \
    "$source_dir/web/src" "$source_dir/web/index.html" "$source_dir/web/vite.config.ts" "$candidate/web/"
  install -m 0644 "$source_dir/deploy/delta-chat-mcp.service" "$source_dir/deploy/check-ready.ts" "$candidate/deploy/"
  install -m 0755 "$source_dir/deploy/install.sh" "$source_dir/deploy/uninstall.sh" "$candidate/deploy/"
  normalize_public_artifacts "$candidate"
}

verify_runtime() {
  local version
  version=$("$1" --version)
  [[ $version == 'deno 2.9.6 '* ]] || die 'Verified archive has an unexpected Deno version.'
}

download_deno() {
  local archive=deno-x86_64-unknown-linux-gnu.zip
  local base=https://github.com/denoland/deno/releases/download/v2.9.6
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 180 \
    "$base/$archive" -o "$transaction/$archive"
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 60 \
    "$base/$archive.sha256sum" -o "$transaction/$archive.sha256sum"
  (cd "$transaction" && sha256sum --check --status "$archive.sha256sum")
  install -d -m 0755 "$transaction/runtime"
  unzip -q "$transaction/$archive" -d "$transaction/runtime"
  normalize_public_artifacts "$transaction/runtime"
  verify_runtime "$transaction/runtime/deno"
}

as_service() {
  runuser -u delta-chat-mcp -- env -i \
    HOME="$cache/tmp" PATH=/usr/local/bin:/usr/bin:/bin \
    DENO_DIR="$cache/deno" TMPDIR="$cache/tmp" "$@"
}

build_candidate() {
  # Files stay root-owned. Vite on Deno writes its temporary bundled config
  # beside web/vite.config.ts (vite/dist/node/chunks/node.js); permit that
  # directory entry only during build, then seal the entire installed tree.
  chgrp delta-chat-mcp "$candidate/web"
  chmod 0775 "$candidate/web"
  install -d -o delta-chat-mcp -g delta-chat-mcp -m 0755 \
    "$candidate/node_modules" "$candidate/web/dist"
  as_service bash -euo pipefail -s -- "$candidate" "$transaction/runtime/deno" <<'BUILD'
export PATH="$(dirname "$2"):$PATH"
cd "$1"
timeout 240 "$2" install --frozen
timeout 180 "$2" task build:web
BUILD
  chown -R root:root "$candidate"
  normalize_public_artifacts "$candidate"
}

rollback() {
  local status=$?
  trap - EXIT
  if test "$activation" = started; then
    systemctl stop delta-chat-mcp || true
    # Retain failed candidate for diagnosis; never roll back/delete state/config.
    if test "$app_swapped" = yes && test -d "$app"; then mv "$app" "$transaction/failed-app"; fi
    if test -d "$transaction/previous-app"; then mv "$transaction/previous-app" "$app"; fi
    if test -f "$transaction/previous-unit"; then
      install -m 0644 "$transaction/previous-unit" "$unit"
    else
      systemctl disable delta-chat-mcp || true
      if test -f "$unit"; then mv "$unit" "$transaction/failed-unit"; fi
    fi
    if test -f "$transaction/previous-deno"; then
      install -m 0755 "$transaction/previous-deno" "$deno_bin"
    elif test -f "$deno_bin"; then
      mv "$deno_bin" "$transaction/failed-deno"
    fi
    systemctl daemon-reload
    if test -f "$transaction/previous-unit"; then
      if test "$was_enabled" = yes; then systemctl enable delta-chat-mcp
      else systemctl disable delta-chat-mcp; fi
    fi
    if test "$was_active" = yes; then systemctl start delta-chat-mcp; fi
    printf 'Activation failed; previous app/runtime/unit restored (previous active=%s).\n' "$was_active" >&2
  fi
  chmod 0700 "$transaction"
  printf 'Installer failed; retained transaction: %s; state/config preserved.\n' "$transaction" >&2
  exit "$status"
}

activate() {
  was_active=no; was_enabled=no
  if systemctl is-active --quiet delta-chat-mcp; then was_active=yes; fi
  if systemctl is-enabled --quiet delta-chat-mcp; then was_enabled=yes; fi
  if test -f "$unit"; then cp -p "$unit" "$transaction/previous-unit"; fi
  if test -f "$deno_bin"; then cp -p "$deno_bin" "$transaction/previous-deno"; fi
  if test "$was_active" = yes || test -f "$unit"; then systemctl stop delta-chat-mcp; fi
  activation=started
  app_swapped=no
  if test -d "$app"; then mv "$app" "$transaction/previous-app"; fi
  mv "$candidate" "$app"
  app_swapped=yes
  install -m 0755 "$transaction/runtime/deno" "$deno_bin"
  install -m 0644 "$app/deploy/delta-chat-mcp.service" "$unit"
  systemctl daemon-reload
  systemctl enable delta-chat-mcp
  # ExecStartPost waits for the configured listener AND ready core.
  systemctl restart delta-chat-mcp
  activation=committed
}

main() {
  platform_check
  test "$#" = 0 || die 'Usage: ./deploy/install.sh (run from an extracted source tree)'
  local command
  for command in curl unzip sha256sum rsync runuser useradd getent flock systemctl \
    timeout install mktemp realpath; do
    command -v "$command" >/dev/null || die "Required Debian package command missing: $command"
  done
  source_dir=$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")
  source_check
  app=/opt/delta-chat-mcp
  unit=/etc/systemd/system/delta-chat-mcp.service
  deno_bin=/usr/local/bin/deno
  cache=/var/cache/delta-chat-mcp
  if [[ -L $app || -L $cache || -L /var/lib/delta-chat-mcp || \
    -L /etc/delta-chat-mcp || -L $unit || -L $deno_bin ]]; then die 'Refusing symlink at a managed path.'; fi
  install -d -m 0755 "$cache"
  exec 9>"$cache/install.lock"
  flock -n 9 || die 'Another installer or uninstaller owns the deployment lock.'
  if ! getent passwd delta-chat-mcp >/dev/null; then
    useradd --system --user-group --home-dir /var/lib/delta-chat-mcp --no-create-home \
      --shell /usr/sbin/nologin delta-chat-mcp
  fi
  test "$(id -u delta-chat-mcp)" != 0 || die 'Service account must be unprivileged.'
  if ! test -e /var/lib/delta-chat-mcp; then
    install -d -o delta-chat-mcp -g delta-chat-mcp -m 0700 /var/lib/delta-chat-mcp
  else
    test "$(stat -c '%U:%a' /var/lib/delta-chat-mcp)" = delta-chat-mcp:700 || die 'Existing state must be delta-chat-mcp-owned, mode 0700; preserved untouched.'
  fi
  if ! test -e /etc/delta-chat-mcp; then
    install -d -o root -g delta-chat-mcp -m 0750 /etc/delta-chat-mcp
  fi
  install -d -o delta-chat-mcp -g delta-chat-mcp -m 0700 "$cache/deno" "$cache/tmp"
  export TMPDIR="$cache/tmp"
  transaction=$(mktemp -d /opt/.delta-chat-mcp-install-XXXXXXXX)
  # Service user traverses this directory to run the verified runtime/build.
  chmod 0755 "$transaction"
  candidate="$transaction/candidate"
  install -d -m 0755 "$candidate"
  activation=preparing; was_active=no; was_enabled=no; app_swapped=no
  trap rollback EXIT
  copy_source
  download_deno
  build_candidate
  activate
  trap - EXIT
  chmod 0700 "$transaction"
  printf 'Installed Deno 2.9.6 and enabled delta-chat-mcp. State/config preserved.\n'
  printf 'Transaction/previous release retained: %s\n' "$transaction"
  printf 'Default URL: http://%s:8080/ (use the configured port if overridden)\n' "$(hostname -I | cut -d ' ' -f 1)"
  printf 'Status: systemctl status delta-chat-mcp; logs: journalctl -u delta-chat-mcp\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
