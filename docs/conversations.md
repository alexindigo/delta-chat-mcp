# Explicit-reply conversations

The OpenCode v2 and Claude Code integrations deliver subscribed room messages
automatically. The agent answers by calling `send_message`. Delta Chat core owns
the shared conversation history; `read_messages` retrieves earlier context.

These are separate entries from the existing v1 automatic-mirroring plugin.
Terminal responses stay in the native session. An incoming turn without a
confirmed send records `empty`, meaning no confirmed chat reply. An uncertain
send records conservative progress and must be inspected in chat history before
a deliberate new send. The integration never resends it automatically.

## Configuration

Both entries accept the same explicit configuration:

```json
{
  "stateFile": "/absolute/private/channel-progress.sqlite",
  "relays": {
    "chat": {
      "url": "http://relay.home:8080/mcp",
      "enabled": true,
      "headers": { "Authorization": { "env": "DELTA_CHAT_MCP_HEADER" } }
    }
  }
}
```

Set `DELTA_CHAT_MCP_HEADER` to the complete `Bearer ...` value in the native
application's environment. Literal headers also work. Public relays use
`"headers": {}`. An absent referenced variable, unresolved placeholder,
URL-embedded credential or invalid option is rejected. Credentials stay outside
progress and model input. `enabled:false` pauses that integration edge while
preserving server subscriptions. Configuration changes take effect on a normal
native reload/restart, performed separately from installation.

The state file contains process ownership, native references, authenticated
relay/inbox scope, claims and send receipts, not message or answer bodies. Locks
are scoped to an OpenCode project or a Claude native session. Independent Claude
sessions can use the same file; concurrent owners of the same native scope are
rejected unless the prior owner is positively proved dead. Keep state private
and on the same disk-backed machine/namespace as its native processes.

## OpenCode v2

The native API pin is OpenCode2.2.5. Build `integrations/opencode-v2/server.js`
and keep it beside `integrations/opencode-v2/package.json`. V2 loads the package
directory, rather than a bare JavaScript file. Add it to v2's `plugins` setting:

```json
{
  "plugins": [{
    "package": "file:///absolute/path/integrations/opencode-v2/",
    "options": {
      "stateFile": "/absolute/private/opencode-v2.sqlite",
      "relays": {
        "chat": {
          "url": "http://relay.home:8080/mcp",
          "enabled": true,
          "headers": { "Authorization": { "env": "DELTA_CHAT_MCP_HEADER" } }
        }
      }
    }
  }]
}
```

The public tools use Code Mode, for example
`tools.chat.send_message({chat_id: 42, text: "Hello"})`. Native permission
checks still apply. The adapter supplies the native session identity. Code Mode
child calls share parent identifiers, so each actual invocation owns its own
prepared send intent.

A running loaded project can receive without an open UI. After a whole server
restart the project still has to load normally; this release adds no startup
helper. New incoming work can catch up after that load. Unknown earlier native
dispatches are retained rather than blindly replayed.

## Claude Code

The native API pin is Claude Code2.1.316. The plugin uses Deno2.9.6 on Linux for
its bundled worker and command hooks. Put `deno` on the native CLI's PATH. Keep
`worker.js`, `hook.js`, `.mcp.json`, `.claude-plugin/plugin.json` and
`hooks/hooks.json` together under `integrations/claude-code/`.

Save the configuration above as `config.json` in this plugin's persistent
`CLAUDE_PLUGIN_DATA` directory. Claude documents that directory as
`~/.claude/plugins/data/<sanitized-plugin-id>/`. A direct `--plugin-dir` load
has an `@inline` identifier; a marketplace install uses `name@marketplace`. The
native host substitutes the actual path into both the hook and worker arguments.
Respect `CLAUDE_CONFIG_DIR` when using a separate native profile.

For a local development load, the user starts:

```sh
claude --plugin-dir /absolute/path/integrations/claude-code --dangerously-load-development-channels plugin:delta-chat@inline
```

Accept the native development-channel confirmation yourself. This release does
not bypass it, approve tool permission prompts, or relay permissions remotely.
The development flag is ignored in print/SDK mode. Channels also require the
native account/organization policy to allow them. Do not set
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` for a Channels session: it prevented
channel availability in the isolated native characterization.

The local stdio connection uses2025-11-25, which the native Channels client
supports; the remote relay connection uses2026-07-28. The worker binds the
actual native CLI session through SessionStart before claiming work. Native
prompt/tool observations correlate input and explicit sends without parsing
private transcripts. A notification write alone is never treated as native
consumption. Unknown dispatches stay held for inspection. Native interruption
and permission waits are not overridden by the receiver.

## Rooms and activation

Call `status` and `list_contacts` to inspect the relay, then use an existing
room or create one. A successful room send subscribes the native session;
explicit `room_subscribe` joins/rejoins as well. Membership persists until
`room_leave`. Ordinary subscribed agent calls express interest; the relay
selects the latest interested subscriber. Inbox reads, claims and completion do
not move interest. Unclaimed busy work remains batched on the relay. Core
message order, full bodies, sender/quote/forward facts and
returned-incoming-only read receipts are preserved.

During a separately reviewed live activation, remove the duplicate native remote
MCP entry for an alias now owned by this integration. The plugin's own
configuration controls its connection, tools and receiver together. Preserve
unrelated MCP entries, authentication and user sessions.

## Development verification

This task's explicitly authorized execution target is existing Podman
`claude-experiments`, ID
`753bf48d3c4ecb5d5ff3145f321b3f3f0756d254d870cc649f50b26346c741f6`. The private
source/runtime/evidence root is
`/home/user/TemporaryFiles/delta-chat-mcp/plans/v2-claude-two-way`. From the
orchestration host, after exact-source delivery:

```sh
T=/home/user/TemporaryFiles/delta-chat-mcp/plans/v2-claude-two-way
podman exec --env TMPDIR="$T/.tmp" --env DENO_DIR="$T/.deno" --workdir "$T/source" claude-experiments "$T/tools/deno-2.9.6" task check:conversations
podman exec --env TMPDIR="$T/.tmp" --env DENO_DIR="$T/.deno" --workdir "$T/source" claude-experiments "$T/tools/deno-2.9.6" task test:conversations
podman exec --env TMPDIR="$T/.tmp" --env DENO_DIR="$T/.deno" --workdir "$T/source" claude-experiments "$T/tools/deno-2.9.6" task build:conversations
podman exec --env TMPDIR="$T/.tmp" --env DENO_DIR="$T/.deno" --env OPENCODE_V2_BIN=/opt/claude-experiments/bin/opencode --workdir "$T/source" claude-experiments "$T/tools/deno-2.9.6" task test:opencode-v2
podman exec --env TMPDIR="$T/.tmp" --env DENO_DIR="$T/.deno" --env CLAUDE_CODE_BIN=/opt/claude-experiments/bin/claude --env CHANNEL_DENO_BIN="$T/tools/deno-2.9.6" --workdir "$T/source" claude-experiments "$T/tools/deno-2.9.6" task test:claude-code
```

Scoped tests use `--allow-all` because Deno2.9.6 protects the Linux proc
identity reads used by the ownership witness even with `--allow-read`. This
stays inside the specifically authorized container and changes no native agent
permissions. The ordinary Claude native test proves tool flow and teardown, not
incoming Channels delivery. Interactive channel, encrypted peer and cross-client
handoff qualification remain separate gates. If the named container is
unavailable, stop and resolve access rather than running workloads on the host.

The encrypted native handoff gate has a repository-owned terminal controller. It
controls only terminal input/capture on the orchestration host; the test,
terminal-state observer, native clients and all outcome assertions run inside
the explicitly named container. After exact-source delivery and the bundle
build:

```sh
python3 integrations/conversations/tests/terminal_driver.py start \
  --workspace "$T" --name conversation-handoff-final \
  --container claude-experiments \
  --expected-container-id 753bf48d3c4ecb5d5ff3145f321b3f3f0756d254d870cc649f50b26346c741f6 \
  --approvals "$T/evidence/claude-channel-01/config/.claude.json" \
  --project "$T/evidence/claude-channel-01/project" \
  --confirm-development-channel
```

Supply `--confirm-development-channel` only with explicit user consent for the
Delta Chat development confirmations. Other dialogs are never answered. The
approval file/project above are a previously human-approved private fixture
using only `sk-ant-api03-private-fixture-only`; create/approve such a private
profile yourself before a fresh setup. Use only that private fixture profile;
the test checks its dummy-key approval and workspace trust. Use a unique
evidence name and inspect any earlier run before a deliberate new attempt.
State, consent receipts, full driver/PTY logs and the guest's results live under
`$T/evidence/`. The optional pinned xterm5.5.0 observer uses its own
evidence-local Deno config/lock, leaving backend dependencies unchanged.

This controller runs `test:conversation-handoff`, including packaged loading,
actual encrypted stock-peer replies, recipient changes between clients, large
bodies, quote/forward facts, busy batching, compaction/resume, interruption,
explicit leave and a deliberately lost send receipt. Inspect both the final
controller exit and guest `result.json`; a running process or a dialog
acceptance is not an end-to-end result.
