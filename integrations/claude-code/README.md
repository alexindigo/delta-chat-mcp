# Delta Chat channel

This Claude Code plugin receives subscribed Delta Chat room messages through
Channels. Claude replies with explicit MCP messaging tools. Delta Chat core
holds conversation history; terminal answers are not sent automatically.

The plugin targets Claude Code2.1.316 and Deno2.9.6 on Linux. Build its worker
and hook bundles with `build:conversations`, keep the plugin directory together,
and place private relay configuration in the plugin's persistent data directory.
Native channel consent and tool permission checks remain in effect.

See the repository's
[configuration and installation guide](../../docs/conversations.md) for the JSON
format, package layout, native activation command and qualification boundaries.
Live activation is a separate user-controlled step.

License: LGPL-3.0-only.
