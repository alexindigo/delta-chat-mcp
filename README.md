# delta-chat-mcp

A LAN service with its own Delta Chat identity, exposed through MCP and a small
web UI. This repository currently contains M0 foundations and offline
integration proofs, not a running messaging service.

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
```

`test` is the offline suite and explicitly excludes `tests/online/`.
`test:online` is reserved for later relay tests; M0 does not create or contact
an online account. `start` currently loads the configuration placeholder and
exits.

## Architecture

Delta Chat core owns identity, contacts and message history. `src/core/` owns
its process and typed RPC client; later messaging services will be shared by
thin MCP and web adapters. App state is separate from message history. No cursor
or message journal is maintained. The counter web spike is technical
scaffolding, not the product's visual design.

The service is intended for plain HTTP on the LAN. Future cookies and API keys
will travel unencrypted on that LAN; it is not intended for public exposure.

## License

LGPL-3.0-only; see `LICENSE`.
