# Binary and container installation

Version0.1.0 supports Linux x86_64 only. Use a trusted LAN: the default
`0.0.0.0:8080` listener uses plain HTTP. The service owns its native Delta Chat
core independently of clients. No installed Deno, Node, checkout or runtime
dependency download is needed for the compiled service. Integrations still
require their documented native client runtimes.

## Binary download

Download both `delta-chat-mcp-0.1.0-linux-x86_64.tar.gz` and `SHA256SUMS` from
<https://github.com/alexindigo/delta-chat-mcp/releases/tag/v0.1.0>. Verify the
matching checksum before extracting:

```sh
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf delta-chat-mcp-0.1.0-linux-x86_64.tar.gz
```

The archive contains the executable, original notices/licenses, provenance,
resource hashes and `ABI.txt`. Read `ABI.txt` for the actual executable's
measured GNU loader, required shared libraries and GLIBC symbol versions. This
is a self-contained application, not a fully static or musl-compatible ELF.
Debian13 x86_64 supplies the required glibc/libgcc runtime and CA certificates.

Run as an unprivileged user with private, disk-backed directories. These example
commands are for the installation machine, not an agent's orchestration host:

```sh
umask 077
mkdir -p "$HOME/.local/share/delta-chat-mcp/state" \
  "$HOME/.local/share/delta-chat-mcp/tmp" \
  "$HOME/.local/share/delta-chat-mcp/cache"
export DCMCP_DATA_DIR="$HOME/.local/share/delta-chat-mcp/state"
export TMPDIR="$HOME/.local/share/delta-chat-mcp/tmp"
export XDG_DATA_HOME="$HOME/.local/share/delta-chat-mcp/cache"
./delta-chat-mcp-0.1.0-linux-x86_64/delta-chat-mcp
```

First start extracts immutable resources once beside the executable at
`.<executable-name>/<content-hash>/`. With a sealed executable directory, Deno
uses `$XDG_DATA_HOME/<executable-name>/<content-hash>/`. Give only the service
user write access to that cache; do not share it with untrusted users. Keep
`DCMCP_DATA_DIR` separate from extracted resources. A read-only external TOML
overlay can be selected with `DCMCP_CONFIG`; `DCMCP_*` leaves override it. The
shipped defaults remain the base. There is no version-query CLI: executing the
binary starts the service.

`GET /_/health` initially returns
`{"ok":true,"core":"ready","configured":false}`. Open the root URL, choose
access settings, create an identity and pair contacts. Use the browser to create
an API key for protected `/mcp` access. SIGTERM/SIGINT stops admission, drains
bounded requests and joins the native child. Wait for exit before upgrading or
backing up.

## Container

The amd64 image is `ghcr.io/alexindigo/delta-chat-mcp:0.1.0`. It runs direct
service exec as UID/GID1000, exposes8080 and contains no installed Deno/Node or
source-entrypoint fallback. Use a named volume:

```sh
docker volume create delta-chat-mcp-data
docker run --detach --name delta-chat-mcp --restart unless-stopped \
  --publish 8080:8080 \
  --mount type=volume,source=delta-chat-mcp-data,target=/data \
  ghcr.io/alexindigo/delta-chat-mcp:0.1.0
```

The image initializes `/data/state`, `/data/tmp`, `/data/cache` and `/data/home`
as private UID/GID1000 directories. `DCMCP_DATA_DIR=/data/state`,
`TMPDIR=/data/tmp`, `XDG_DATA_HOME=/data/cache`, `HOME=/data/home`. The sealed
`/app` directory forces extraction into the private disk-backed cache. A bind
mount replaces the image's directory layout: prepare the same four directories
with owner1000:1000 and mode0700 on the installation machine before mounting it.
An empty root-owned bind mount is not writable by the service.

For operator configuration add a separate read-only bind mount, for example
`--mount type=bind,source=/absolute/config.toml,target=/config.toml,readonly`
and `--env DCMCP_CONFIG=/config.toml`. Do not put secrets into image layers.
Back up the entire stopped `/data` volume, including identity/auth/database/blob
state, and retain external config separately. Extraction cache is regenerable;
it is not identity state. Do not run two copies of a restored identity.

Immutable version tag `0.1.0` and forward-only aliases `0.1` and `latest` are
published together. There is no `0` alias. Prefer a version or digest for
upgrades, stop before replacing the container, and reuse the same data volume.

## Integration archive

`delta-chat-mcp-0.1.0-integrations.tar.gz` contains the OpenCode v1 bundle,
OpenCode v2 package (`server.js` plus `package.json`) and complete Claude plugin
(`worker.js`, `hook.js`, `.mcp.json`, `.claude-plugin/plugin.json`,
`hooks/hooks.json`). Preserve descriptors, including hidden files, beside their
bundles. Read its `README.md` for v1 and `docs/conversations.md` for v2/Claude
installation and native runtime pins. Install and activate explicitly; the
archive never edits native clients, credentials or live sessions. V2 and Claude
use explicit MCP sends for replies. Claude hooks/worker require Deno2.9.6 on the
native client's PATH.

## Rebuild and qualification

Use matching source tag `v0.1.0` and Deno2.9.6. Build tools need network access
to pinned JSR/npm/upstream source inputs, GNU tar/gzip and readelf (binutils).
Dependencies remain frozen. The build creates a new output directory and retains
failures; select a fresh output for a deliberate new attempt.

```sh
export TMPDIR="$PWD/.test-state/release/tmp"
export DENO_DIR="$PWD/.test-state/release/deno"
mkdir -p "$TMPDIR" "$DENO_DIR"
OUT="$PWD/.test-state/release/output"
timeout 1200 deno run -A scripts/release/build.ts --output "$OUT"
timeout 600 deno run -A scripts/release/smoke.ts --binary "$OUT/bin/delta-chat-mcp" --assets web/dist --workspace "$OUT/smoke-binary"
timeout 900 deno run -A scripts/release/online.ts --binary "$OUT/bin/delta-chat-mcp" --workspace "$OUT/online-binary"
```

Agent execution is restricted to the explicitly authorized targets recorded in
the external packaging plan. Docker build/run qualification is restricted to
GitHub-hosted `ubuntu-24.04` VM jobs. CI records VM identity and uses
disk-backed workspace TMPDIR. It builds/tests without publishing. The unchanged
normal hook in dedicated agora CT802 runs the full257offline plus3lifecycle
gates. GitHub runs complementary portable checks and artifact/image smoke; it
does not spoof the strict native-test ownership profile.

The reusable smoke exercises the packaged process itself from an empty cwd,
private HOME/cache and a service PATH without Deno/Node. It checks native child
execution, all built asset bytes/MIME, deep navigation, reflective HTTP/MCP,
public and protected auth, persistence, config errors/precedence and bounded
normal/incomplete shutdown. The separate online gate creates fresh throwaway
identities and requires encrypted plaintext at the actual stock-peer and MCP
history consumers.

The coordinated stable-tag workflow verifies the merged default-branch source,
VERSION/changelog and forward semver ordering, qualifies first, publishes only
the tested image, attaches both archives/checksums to a draft release, then
publishes it. Public anonymous download/digest/pulled-image smoke are final
publication gates. A private GHCR package is reported as a visibility blocker,
never advertised as publicly qualified. Public tags are never moved/replaced.
