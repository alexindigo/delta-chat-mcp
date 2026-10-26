# delta-chat-mcp

A LAN service with its own Delta Chat identity, exposed through MCP and a small
web UI. The backend owns the core process independently of connected clients.
The web UI provides access setup, login, API keys, identity setup, contact
pairing, room creation, live conversations and a text composer; `/mcp` provides
nine messaging tools. The native compiler counter and ping transport are
isolated integration fixtures.

## Deploy

Use the [Debian LXC deployment guide](docs/deploy.md) for the verified Deno
installer, non-root systemd service, configuration, upgrades, whole-state
backup/restore and data-preserving uninstall. The default is all-interface plain
HTTP on port 8080; browser cookies and API keys travel unencrypted on the LAN.
OpenCode uses its own environment-held API key as described below.

## Development

Use Deno 2.9.6 on Linux x86_64. Dependency versions are pinned in `deno.json`
and `deno.lock`. Builds and tests run in the project's dedicated development
LXC, with `TMPDIR` pointing to its disk-backed workspace. Chromium is required
for the web spike. Do not test against a real account.

```sh
deno install --frozen
deno task fmt:check
deno task lint
deno task check
deno task test
deno task build:web
```

`test` is the offline suite and explicitly excludes `tests/online/`.
`test:online` is isolated from that suite and uses throwaway identities on the
selected relay. `start` runs the service until SIGTERM or SIGINT. The public
health endpoint is `GET /_/health`; it reports core readiness/recovery and
whether the messaging identity is configured.

Interrupted first identity setup is retryable: creation resumes the same core
account while it remains unconfigured, including after restart. A configured
identity cannot be replaced, and multiple allocated identities are rejected.
Account keys and history are never reset to recover provisioning.

On shutdown the composition owner stops application admission, gives accepted
HTTP work a one-second drain window, then cancels remaining connections and
joins request handlers and the core child before closing state. Incomplete
uploads or streamed responses cannot hold the native HTTP server open
indefinitely.

## Configuration and access

Shipped `defaults/config.toml` documents each setting. An optional file selected
by `DCMCP_CONFIG` overrides individual leaves; `DCMCP_*` variables override that
file. Unknown keys, sections used as values, and malformed types fail startup.
The listener defaults to `0.0.0.0:8080`; no public URL or hostname allowlist is
required. State defaults to `./data` (`DCMCP_DATA_DIR`).

Access starts unconfigured. Backend routes under `/api/auth/` provide setup,
login, logout and session status. Setup selects `public`, `password`, or `totp`
(password plus TOTP). `POST /api/auth/enroll` returns a standard Base32
enrollment key, otpauth URI and server-rendered SVG while setup is available;
TOTP setup requires confirmation with a six-digit code. Setup issues the initial
browser cookie. There is no per-browser session registry.

Environment setup uses `DCMCP_AUTH_TYPE`, `DCMCP_AUTH_USERNAME`,
`DCMCP_AUTH_PASSWORD`, and for TOTP `DCMCP_AUTH_TOTPKEY` (Base32). Optional
`DCMCP_AUTH_SECRETKEY` pins the browser signing key;
`DCMCP_AUTH_SESSIONEXPIRYDAYS` controls its lifetime. Initial environment setup
initializes private access state. Subsequent overrides preserve the saved
credentials: removing an override restores the saved value. Credential changes
rotate the automatically owned signing key. If an operator explicitly pins that
key, a credential change must also supply a different key.

`auth.toml` is mode 0600 inside the mode-0700 data directory. Passwords are
stored as salted PBKDF2-SHA256 hashes. The same private file holds
signing/replay bookkeeping, separately from the saved settings, so accepted TOTP
steps cannot be reused after restart. The application database contains only
schema and API key metadata; API keys use random 256-bit values, are returned
once, and are stored only as SHA-256 digests.

Browser routes accept only the session cookie. Mutating requests require the
request's own Origin. Event streams require that Origin or a same-origin Referer
(native EventSource omits Origin on plain HTTP); missing/cross-origin provenance
is rejected. `/mcp` accepts only Bearer API keys in protected modes and rechecks
them on every request, including requests on known MCP sessions. Each protected
MCP session belongs to the key that initialized it; another key cannot reuse
that session ID. Deleting a key immediately closes its sessions and cancels live
waits/streams. Idle sessions expire after 30 minutes; shutdown closes MCP
lifetimes before draining HTTP. Public mode opens access and emits a startup
warning.

The offline suite proves RPC restart persistence, MCP
handshake/list/call/session cleanup through Pathfinder, SQLite disk persistence,
and an actual Solid 2 native build followed by a hit-tested Chromium pointer
click from `0` to `1` in `tests/fixtures/counter/`. This preserves the M0
toolchain proof independently of product screens. Product browser tests also
build the real UI, complete public setup, follow navigation and switch themes.
Browser evidence is saved in `artifacts/m0/`, `artifacts/m2/` and
`artifacts/m3/`. The web test uses a non-loopback HTTP hostname and asserts
`isSecureContext === false`. Chromium's test-only resolver rule maps that
hostname to the development guest's LAN address; the Deno MCP client uses the
LAN IP directly because browser resolver flags cannot affect Deno.

## Architecture

Delta Chat core owns identity, contacts and message history. `src/core/` owns
its process and typed RPC client. Shared messaging services own account,
contact, chat, send/delete and read-receipt workflows. Thin MCP adapters call
those services. App state is separate from message history. No cursor or message
journal is maintained. Views render state and forward intents; plain TypeScript
controllers own access, keys, messaging, room setup and ephemeral drafts, with
one owner each for HTTP, live invalidations, message visibility, theme/storage,
browser location/history and clipboard. Bundled fonts require no CDN. The
labelled **Theme: choice** header entry opens a native family-grouped picker on
access/login and authenticated pages. System plus all 15 named Globnotes themes
have actual conversation previews. Arrow keys/Home/End move focus without
selecting; Enter/Space or a pointer activation immediately applies/persists the
choice, keeping the picker open. Done/Escape closes it. System follows live OS
changes and shows the current default; explicit names ignore OS. A
pre-stylesheet head bootstrap and concrete-theme CSS prevent a wrong-theme
flash. Saved legacy Light/Dark choices retain their meaning; denied storage
keeps page-lifetime use. Copying has a plain-HTTP fallback.

Shared room setup validates the whole intended contact set before allocation and
verifies canonical encrypted Group/SELF/member facts afterward. Browser cookie
routes (`POST /api/rooms` and `POST /api/rooms/:id/complete`) and MCP use this
same service. Native Dialog owns DOM/focus only; app composition gives a
shown-once key priority over Room/Theme without clearing their controller state.

The desk uses Globnotes' named catalog with derived readable text and control
roles; [palette provenance](docs/palette.md) records the source and contrast
policy. Native selects share one inset decorative chevron while the full native
control retains pointer, keyboard and option semantics.

## Messaging in the browser

The default setup order is **Identity → Contacts → API keys → Chats** (Public
mode skips keys). Progress follows actual core facts, not a separate setup
record; loading/recovery waits for those facts. Explicit screen links remain
available, existing keys are retained, and live progress offers a next action
without moving you away from input.

Open **Identity**, enter a display name and choose a publicly listed Chatmail
relay. The bundled factual hostname/homepage snapshot comes from
<https://chatmail.at/relays> (retrieved 2026-10-25), under
`defaults/public-relays.json`. No website prose or artwork is redistributed and
no site-wide license is asserted. Inclusion does not promise availability or
open registration. The same-origin catalog is available offline immediately;
explicit refresh fetches only that fixed HTML directory server-side, bounded to
128 KiB and five seconds, retaining the last good list in memory on failure. It
never probes providers or creates accounts. Actual account creation and
messaging need network access. **Custom / private relay** accepts a domain or
full `DCACCOUNT:` URI, preserved unchanged through refresh. Creation uses the
existing single transport workflow, not automatic multi-relay selection.

An interrupted setup retries the same identity; form input is kept after errors.
**Contacts** displays one core-generated invitation as both a scannable SVG and
a copyable link. Scan it with Delta Chat, or paste a contact's invitation to
join them. Email addresses alone are not pairing invitations. Contacts show the
current core's **Key contact** and **Encryption available** state, and incoming
requests offer **Accept** or **Block**.

Use a contact's **Chat** action or choose a conversation in **Chats**. Choose
**New room** beside Conversations (beside Chats on a narrow selected
conversation), enter a name and select actual contacts. Zero selected contacts
means **Only this identity**; one peer still creates a Group, not a direct chat.
Every selected contact must still be unblocked, a key contact, and available for
encryption when submitted. Creating a room does not deliver it to peers: the
first message distributes it. The explanation follows actual core promotion
metadata, not empty history.

If adding contacts or verification fails after allocation, the actual room ID
and intended selection are kept. **Retry adding contacts** explicitly completes
that same unpromoted room, adding only missing contacts. **Open room** inspects
it. A distributed room or one this identity left cannot be completed through
setup. Dismissing setup keeps the actual room. If creation was not acknowledged,
a room may exist: inspect refreshed Conversations before deliberately choosing
**Create another room (may duplicate)**. Ordinary Create stays disabled; there
is no blind retry, persistent setup journal, or automatic deletion. Close/Escape
keeps the form and recovery state in page memory across navigation; explicit
discard/logout/document-departure protection includes this draft.

Agent-created rooms also appear live. History pages load upwards. Enter sends,
Shift+Enter adds a line; delivery/read status comes from core. Downloaded core
JPEG/PNG/WebP images, GIFs and eligible stickers render inline with their
caption and filename. Other attachments retain their filename fallback; partial,
failed and undecipherable downloads show their actual state without
automatically downloading. A broken image retains its message and offers up to
two explicit retries. Selected deletion is explicit and local to this identity.
GET inspection does not mark messages seen; only messages presented in the
visible conversation send browser read receipts. Reading in either interface
leaves the same history available to the other.

Private image bytes use cookie-authenticated `GET /api/messages/:id/image`,
never raw blob paths or filename URLs. Core metadata and delivery share one
format policy. Each request rechecks current existence and the core-provided
blob root, regular-file containment, size and raster signature, then streams the
same opened handle with no-store, nosniff and same-origin resource policy. HEAD
is deliberately 405; Range is ignored (complete 200). Native stream ownership
closes the handle on EOF/cancel; image inspection never sends read receipts.
Missing-blob metadata errors remain load errors, distinct from deletion. The
private service-owned data directory is trusted against same-UID filesystem
swaps; this is not an atomic hostile-writer defense or a full image decoder. The
browser viewport owner tracks a visible-message anchor across paging and delayed
image sizing. History rows are keyed by core message ID, so metadata refreshes
update existing native images and selection controls instead of refetching media
or replacing an interaction target.

One bounded SSE stream sends coalesced change hints, not another message
journal. Every reconnect/boot handshake refetches canonical core state.
**Status** shows the actual identity, core readiness and chatmail connectivity
separately from the browser's connection. Drafts and form state survive in-app
links, Back/Forward and reconnects in page memory. Failed sends keep text; a
late successful send clears only its matching draft revision. Logout and
document departure protect unsaved input and unacknowledged shown-once keys with
explicit discard intent. Drafts and raw API keys are never persisted in browser
storage.

## Agent connection

Open the relay's LAN URL, complete access setup, then create a named key on
**API keys**. Save the key when it is shown; it cannot be retrieved later. A
focused dialog keeps the rest of the desk blurred and inactive until you choose
**I've saved it**. **Copy key** confirms beside the action only after successful
copying; it keeps the key open. If copying fails, retry or select the key and
save it manually. The page lists created/last-used times and confirms deletion.
Public access explains that no key is needed. API keys grant access to **every
chat** of this identity.

The page supplies a configuration snippet using the browser's actual origin.
Merge this entry into OpenCode yourself; the relay never edits your
configuration. For password or password + TOTP access, set `DELTA_CHAT_MCP_KEY`
in OpenCode's environment to the saved key:

```json
{
  "mcp": {
    "delta-chat": {
      "type": "remote",
      "url": "http://<lan-domain>:<port>/mcp",
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:DELTA_CHAT_MCP_KEY}" },
      "enabled": false
    }
  }
}
```

Omit `headers` in Public mode. Enable the MCP for a coding session and disable
it afterwards; receiving messages continues independently. MCP accepts only the
Bearer credential, never the web cookie. Session IDs are routing state, not
keys.

| Tool                | Purpose                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`            | Identity address/display name, configuration and connectivity                                                                                     |
| `list_contacts`     | Actual `keyContact` and `encryptionAvailable` state; no obsolete verified flag                                                                    |
| `list_chats`        | All chats/rooms/contact requests, member IDs and last message ID/time                                                                             |
| `read_messages`     | Core history oldest→newest; `chat_id`, `after_id` OR `before_id`, default20/max100                                                                |
| `wait_for_messages` | Newer messages or an empty `timedOut:true` result; default120 seconds bounded by `mcp.waitMaxSeconds`; client cancellation releases the wait      |
| `send_message`      | Exact text to `chat_id` OR `contact_id`                                                                                                           |
| `message_status`    | Batch delivery/read/not-found state                                                                                                               |
| `delete_messages`   | Explicit local-only deletion, never for everyone                                                                                                  |
| `create_room`       | Named room with selected `contact_ids`; send its first text to deliver it to peers; optional `resume_chat_id` completes that same unpromoted room |

Every successful tool result contains JSON text plus matching
`structuredContent`. Failures expose sanitized reasons rather than backend
errors or filesystem paths. Room failures additionally return safe structured
`room` facts: `rejected` before allocation, `incomplete` with known `chatId`,
intended/missing contact IDs (null means membership could not be read), and
`completionStopped`, or `uncertain` with no invented ID. Successful
`create_room` results remain `{chat_id}` and the tool count remains nine.
Reading/waiting mark **only returned incoming messages** seen and send read
receipts. Reading never deletes. Remember the last returned ID in the agent
session and pass it explicitly; a deleted/unknown anchor is an error, never an
implicit restart from the beginning. A fresh agent session can create a fresh
room. No cursor, journal, whitelist or persistent per-agent state is added.

The separate online suite uses private throwaway fixtures, the official MCP SDK
over LAN HTTP, real A/B/C relay peers and headless Chromium on
`http://delta-chat-mcp.test`. It proves receiving consumers, encrypted room
first text, delayed/already-present/timeout/aborted waits, peer read receipts,
reconnect history, durable local deletion, revocation of initialized sessions
and shutdown. Browser-created rooms are checked through actual pointer/name/two
paired contacts, canonical Group/SELF/membership/URL, first text decrypted by
both intended stock peers, and a peer reply visible in browser and MCP history.
Native form checks cover recovery, uncertainty, retained drafts, key-modal
priority, checkbox/action geometry, and departure/logout epochs. Browser checks
complete Public/Password/TOTP setup and login/logout, paste a copied key into a
real browser field, use/revoke that key through MCP, exercise System/default
modes and all named themes/live OS/storage errors/keyboard, and compare head
bootstrap timing/computed colors to the browser's first paint. Only final full
Login/Keys/Room/Theme screenshots are deliverables; private region-review
captures remain artifacts.

The service is intended for plain HTTP on the LAN. Cookies and API keys will
travel unencrypted on that LAN; it is not intended for public exposure.

## License

LGPL-3.0-only; see `LICENSE`.
