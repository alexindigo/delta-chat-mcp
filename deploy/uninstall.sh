#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-only
set -euo pipefail

main() {
  test "$(id -u)" = 0 || { printf 'Run as root inside the LXC.\n' >&2; exit 1; }
  local purge=no confirmation
  if test "$#" = 1 && test "$1" = --purge; then purge=yes
  elif test "$#" != 0; then printf 'Usage: ./deploy/uninstall.sh [--purge]\n' >&2; exit 1; fi
  if test "$purge" = yes; then
    test -t 0 || { printf 'Purge requires interactive confirmation.\n' >&2; exit 1; }
    printf 'Delete this identity, private keys, history and API keys? Type PURGE: '
    read -r confirmation
    test "$confirmation" = PURGE || { printf 'Cancelled; nothing changed.\n'; exit 1; }
  fi
  local path
  for path in /opt/delta-chat-mcp /var/lib/delta-chat-mcp /var/cache/delta-chat-mcp \
    /etc/systemd/system/delta-chat-mcp.service; do
    test ! -L "$path" || { printf 'Refusing symlink at managed path: %s\n' "$path" >&2; exit 1; }
  done
  install -d -m 0755 /var/cache/delta-chat-mcp
  exec 9>/var/cache/delta-chat-mcp/install.lock
  flock -n 9 || { printf 'Another deployment owns the lock.\n' >&2; exit 1; }
  systemctl stop delta-chat-mcp
  systemctl disable delta-chat-mcp
  rm -f -- /etc/systemd/system/delta-chat-mcp.service
  systemctl daemon-reload
  rm -rf -- /opt/delta-chat-mcp
  if test "$purge" = yes; then
    rm -rf -- /var/lib/delta-chat-mcp
    printf 'Removed application/unit and purged identity state.\n'
  else
    printf 'Removed application/unit; KEPT /var/lib/delta-chat-mcp (identity, keys, history, auth).\n'
  fi
  printf 'Kept service account, /etc/delta-chat-mcp, cache, previous releases and Deno.\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
