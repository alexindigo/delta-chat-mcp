# Deploy in a Debian LXC

Run the commands in this guide **inside the application LXC as root**. The
installer does not create a container or call Proxmox. Use Debian 13 on Linux
x86_64 with systemd, a LAN address/DNS name, and outbound access to GitHub,
JSR/npm during installation and to your chosen chatmail relay during use. The
deployment proof used an unprivileged Debian 13 LXC with 4 cores, 8 GiB RAM and
a 40 GiB ext4 root filesystem.

The service defaults to **plain HTTP on `0.0.0.0:8080`**, reachable at
`http://<lxc-lan-name>:8080/`. No public URL, hostname allowlist, TLS, reverse
proxy, Docker, Node or npm executable is required. Browser cookies and MCP API
keys travel **unencrypted on the LAN**. Keep this service on the trusted LAN.

## Install

The Debian base must supply Bash, systemd, coreutils, util-linux, passwd, rsync,
curl, ca-certificates and unzip. If the minimal image lacks them, install only
inside that LXC:

```sh
apt-get update
apt-get install -y bash systemd coreutils util-linux passwd rsync curl ca-certificates unzip
```

Copy a trusted checkout or extracted source archive into the LXC, for example
`/root/delta-chat-mcp`. Keep this source tree for subsequent upgrades and
uninstallation. Run:

```sh
cd /root/delta-chat-mcp
./deploy/install.sh
systemctl is-enabled delta-chat-mcp
systemctl is-active delta-chat-mcp
```

Expected: `enabled`, `active`. The installer first checks root, Debian 13,
x86_64 and required source inputs. It downloads **Deno 2.9.6** from the official
GitHub release and verifies the ZIP against that release's published
`deno-x86_64-unknown-linux-gnu.zip.sha256sum` before executing it. It runs the
actual `deno install --frozen` and `deno task build:web` as the unprivileged
service account; the lock selects the **2.65.0 Linux x64 core prebuilt**. No
Rust build or dependency-version substitution is involved.

Application inputs are allowlisted. Checkout metadata, data, test fixtures,
artifacts, local environment files, old node_modules and built assets are not
installed from the source tree. Dependencies and assets are generated in the
LXC. Source files remain root-owned during the build; generated directories and
Vite's temporary bundled-config directory entry are writable during that step.
The entire installed application is then sealed root-owned, without group or
other write permission.

Public artifact permissions are normalized at source-copy, runtime-extraction
and build-sealing boundaries: directories are 0755, ordinary files 0644, and
existing executable tools retain 0755. Installation and same-version upgrade
were both exercised under `umask 077`, including non-root core execution and
external JS, CSS, font and native-browser consumers. The installer does not
relax the caller's umask or apply public modes to identity state, auth,
dependency caches, scratch or operator configuration.

| # | Path                                         | Owner / purpose                                                                                                                        |
| - | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `/opt/delta-chat-mcp`                        | root-owned source, LGPL license, pinned dependencies, deployment scripts and built `web/dist`; service working directory               |
| 2 | `/var/lib/delta-chat-mcp`                    | `delta-chat-mcp:delta-chat-mcp`, 0700; core `accounts/`, `auth.toml`, `app.sqlite` and associated database files                       |
| 3 | `/var/cache/delta-chat-mcp/deno`             | service-owned 0700 `DENO_DIR`; writable dependency/runtime cache                                                                       |
| 4 | `/var/cache/delta-chat-mcp/tmp`              | service-owned 0700 disk-backed `TMPDIR`; installer/build scratch and temporary build HOME                                              |
| 5 | `/var/cache/delta-chat-mcp/install.lock`     | root-owned shared install/uninstall lock                                                                                               |
| 6 | `/etc/delta-chat-mcp`                        | root:delta-chat-mcp 0750; optional operator config/env, never overwritten by installation                                              |
| 7 | `/etc/systemd/system/delta-chat-mcp.service` | root-owned unit; enabled for boot                                                                                                      |
| 8 | `/usr/local/bin/deno`                        | verified Deno 2.9.6 runtime                                                                                                            |
| 9 | `/opt/.delta-chat-mcp-install-XXXXXXXX`      | explicit root-owned transaction directory; previous/failed app, unit and runtime retained for diagnosis, 0700 after completion/failure |

The system account has no login shell. Deno **and its core child** run as
`delta-chat-mcp`, with `NoNewPrivileges=yes`, `UMask=0077`,
`Restart=on-failure`, control-group shutdown and a 30-second stop timeout.
`ExecStart` permissions exactly match `deno.json`'s `start` task (checked by a
deployment test). A bounded `ExecStartPost` check waits for the configured HTTP
listener to report a ready core, including when logging is set to Warn/Error.

From another LAN machine, check:

```sh
curl --fail "http://<lxc-lan-name>:8080/_/health"
```

Expected initially: `{"ok":true,"core":"ready","configured":false}`. Open the
root URL in a browser, choose Public, Password, or Password + TOTP access, then
use **Identity** to create the service's identity on your chosen chatmail relay.
Use **Contacts** to scan/copy an invitation or join the other account's
invitation. The automated proof uses `ci-chatmail.testrun.org` and private CI
identities; real installations choose their own relay.

## Configuration and status

Defaults are in `defaults/config.toml`. The service automatically reads the
optional systemd environment file `/etc/delta-chat-mcp/env`. To use a TOML
overlay, explicitly select it there with `DCMCP_CONFIG`. For example, create
`/etc/delta-chat-mcp/config.toml` with:

```toml
[listen]
hostname = "0.0.0.0"
port = 8181

[log]
level = "info"
```

Create `/etc/delta-chat-mcp/env` with:

```ini
DCMCP_CONFIG=/etc/delta-chat-mcp/config.toml
```

Set permissions and restart:

```sh
chown root:delta-chat-mcp /etc/delta-chat-mcp/config.toml /etc/delta-chat-mcp/env
chmod 0640 /etc/delta-chat-mcp/config.toml /etc/delta-chat-mcp/env
systemctl restart delta-chat-mcp
systemctl status delta-chat-mcp --no-pager
journalctl -u delta-chat-mcp -n 100 --no-pager
```

Use systemd `EnvironmentFile` assignments, not shell commands or `export`.
Individual `DCMCP_*` settings override TOML leaves; unknown keys and malformed
values fail startup. `DCMCP_LISTEN_PORT=8181` is a direct alternative to a file
overlay. Use a stable nonzero port for systemd deployment. Keep the unit's
`DCMCP_DATA_DIR=/var/lib/delta-chat-mcp`, `DENO_DIR` and `TMPDIR` paths for this
layout and its backup commands.

Normal first-run access setup happens in the browser. For unattended access
setup, supported settings are `DCMCP_AUTH_TYPE`, `DCMCP_AUTH_USERNAME`,
`DCMCP_AUTH_PASSWORD`, and `DCMCP_AUTH_TOTPKEY` for TOTP. Protect that file as
above. Existing saved credentials survive removal of environment overrides;
changing credentials rotates the automatically managed browser signing key and
logs browsers out. See
[Configuration and access](../README.md#configuration-and-access) for the
explicitly pinned-key behavior. The installer does not set or reset access
credentials.

## Connect OpenCode

In the web UI, create a named key on **API keys** and save its once-only value.
Set `DELTA_CHAT_MCP_KEY` in **OpenCode's environment**, not the LXC service env.
Merge this entry into OpenCode's configuration yourself:

```json
{
  "mcp": {
    "delta-chat": {
      "type": "remote",
      "url": "http://<lxc-lan-name>:8080/mcp",
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:DELTA_CHAT_MCP_KEY}" },
      "enabled": false
    }
  }
}
```

Use the configured port if changed. Omit `headers` for Public access. Enable the
MCP for a session, then disable it when finished. Receiving and core history
continue without a connected MCP client or browser. API keys see every chat of
this identity; they do not accept a browser cookie or require a TOTP per call.
Deleting a key revokes it immediately. No user OpenCode configuration is edited
by the installer.

## Upgrade and failure behavior

Take the stopped backup below and retain the previous trusted source version.
Copy/extract the new source tree into the LXC and rerun the **same installer**:

```sh
cd /root/delta-chat-mcp
./deploy/install.sh
systemctl is-active delta-chat-mcp
```

Identity keys, contacts, history, auth state, browser signing key and API keys
are preserved. `/etc/delta-chat-mcp` is also preserved; existing private state
must already have the documented owner/mode, otherwise installation stops
without rewriting it. No data is copied or seeded from the checkout.

The old service stays running while a separate candidate downloads, verifies and
builds. Preparation failure leaves it running. After preparation, the installer
stops admission, retains the old app/unit/runtime, replaces them and starts the
new unit. Failed startup/admission restores the old app/runtime/unit and prior
enabled/active state; **it does not roll back, delete or reseed data**. The
installer exits nonzero and prints the retained transaction path. Inspect that
path and the journal before retrying. A killed/power-interrupted root installer
cannot execute its shell rollback trap: retained transaction files are recovery
evidence, not a claim of power-loss-atomic upgrades. The stopped backup is the
recovery point if a future application version changes data.

Transactions are deliberately retained rather than automatically deleted. They
are not identity backups. Remove only a specifically reviewed old transaction
after verifying the deployment and retaining a whole-state backup. Default
uninstall leaves them intact.

## Offline backup of the whole identity and service state

The archive contains **private identity keys, contacts, history, the access
password hash/TOTP/signing state and API key digests**. Protect it as a secret.
Stop the service first; copying just a live SQL database can omit WAL state or
separate core/blob/auth files. Use disk-backed backup storage, not `/tmp`.

Inside the LXC as root:

```sh
set -euo pipefail
umask 077
install -d -m 0700 /root/delta-chat-mcp-backups
archive="/root/delta-chat-mcp-backups/state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
systemctl stop delta-chat-mcp
tar --acls --xattrs -C /var/lib -czpf "$archive" delta-chat-mcp
sha256sum "$archive" > "$archive.sha256"
sha256sum -c "$archive.sha256"
tar --acls --xattrs --compare -zpf "$archive" -C /var/lib
systemctl start delta-chat-mcp
```

A failure leaves the service stopped so the backup can be investigated. Copy the
verified archive/checksum securely to private backup storage outside this LXC.
Separately retain any `/etc/delta-chat-mcp` operator config/env with private
permissions, plus the matching source version. The state archive intentionally
does not contain application files, dependency caches or operator config.

## Restore

On a replacement Debian 13 x86_64 LXC, install the matching trusted source first
to recreate the service account/runtime/application; stop it before restoring
state. Restore any operator config/env separately with root:delta-chat-mcp
ownership and mode 0640. Never run two copies of this restored service identity
at the same time during recovery.

For a trusted archive, inside the LXC as root:

```sh
set -euo pipefail
umask 077
archive="/root/delta-chat-mcp-backups/state-<backup-timestamp>.tar.gz"
sha256sum -c "$archive.sha256"
systemctl stop delta-chat-mcp
retained="/var/lib/delta-chat-mcp.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
if test -e /var/lib/delta-chat-mcp; then
  test ! -e "$retained"
  mv /var/lib/delta-chat-mcp "$retained"
fi
tar --acls --xattrs --same-owner -C /var/lib -xzpf "$archive"
chown -R delta-chat-mcp:delta-chat-mcp /var/lib/delta-chat-mcp
chmod 0700 /var/lib/delta-chat-mcp
chmod 0600 /var/lib/delta-chat-mcp/auth.toml /var/lib/delta-chat-mcp/app.sqlite
systemctl start delta-chat-mcp
systemctl is-active delta-chat-mcp
```

The prior directory is retained instead of destroyed. If extraction fails, keep
the service stopped, preserve both directories and repair the complete restore
before starting. Verify the original address, contact and earlier messages in
the UI, the **old API key** through an actual MCP call, and a newly received
encrypted peer message. Health alone does not prove identity recovery.

This whole-state stopped archive/restore path was exercised with task-owned CI
state in a separate LXC: active state path removed from use, complete archive
restored, actual public-key fingerprint/auth bytes unchanged, original cookie
and API key valid, original identity/contact/history visible to external web
API/MCP/browser consumers, and the next encrypted peer text received.

### Upstream core export is a separate alternative

The pinned `@deltachat/jsonrpc-client` **2.65.0** generated client declares
`exportBackup(accountId, destination, passphrase)` and
`importBackup(accountId, path, passphrase)` (nullable passphrase); these map to
upstream `export_backup` / `import_backup`. They are core-account operations,
not whole-service backups: they do not include this service's auth state or API
key database. They are not exposed by this service's UI, MCP tools or core
facade. Do not start a second core against the live accounts directory to call
them. The export/import restore path was **not runtime-verified here**; use
upstream tooling/documentation if choosing that core-only alternative and retain
the separate app state. The verified operational recovery procedure is the
complete stopped archive above.

## Stop and uninstall

```sh
systemctl stop delta-chat-mcp
cd /root/delta-chat-mcp
./deploy/uninstall.sh
```

Default uninstall stops/disables the service and removes its unit and
`/opt/delta-chat-mcp`. It **keeps `/var/lib/delta-chat-mcp`**, all identity and
access state, operator config/env, caches, service account, Deno and retained
transactions. This allows a later reinstall to resume the same identity.

`./deploy/uninstall.sh --purge` additionally removes the active state directory
only after an interactive terminal confirmation requiring the literal `PURGE`.
Noninteractive input is rejected before any change. Backups and retained restore
directories are independent copies and remain. Purge was not run on the
deployment proof's retained fixture state.
