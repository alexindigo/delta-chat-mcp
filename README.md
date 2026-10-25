# delta-chat-mcp

A LAN service with its own Delta Chat identity, exposed through MCP and a small
web UI. The backend owns the core process independently of connected clients.
Product MCP tools and web screens are separate milestones; the retained counter
and ping endpoints are integration fixtures, not the product interface.

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

Browser routes accept only the session cookie. Mutating requests and event
streams require the request's own Origin. `/mcp` accepts only Bearer API keys in
protected modes and rechecks them on every request, including requests on known
MCP sessions. Public mode opens access and emits a startup warning. The API-key
management UI/routes and product MCP transport are provided by the next
milestone; this backend exposes their access-state modules.

The offline suite proves RPC restart persistence, MCP
handshake/list/call/session cleanup through Pathfinder, SQLite disk persistence,
and an actual Solid 2 native build followed by a hit-tested Chromium pointer
click from `0` to `1`. Browser evidence is saved in `artifacts/m0/`. The web
test uses a non-loopback HTTP hostname and asserts `isSecureContext === false`.
Chromium's test-only resolver rule maps that hostname to the development guest's
LAN address; the Deno MCP client uses the LAN IP directly because browser
resolver flags cannot affect Deno.

## Architecture

Delta Chat core owns identity, contacts and message history. `src/core/` owns
its process and typed RPC client; later messaging services will be shared by
thin MCP and web adapters. App state is separate from message history. No cursor
or message journal is maintained. The counter web spike is technical
scaffolding, not the product's visual design.

The service is intended for plain HTTP on the LAN. Cookies and API keys will
travel unencrypted on that LAN; it is not intended for public exposure.

## License

LGPL-3.0-only; see `LICENSE`.
