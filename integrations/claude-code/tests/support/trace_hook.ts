// SPDX-License-Identifier: LGPL-3.0-only
// Qualification evidence only. Production hooks reduce input to metadata.
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
await Deno.writeTextFile(
  Deno.args[0],
  JSON.stringify({
    time: Date.now(),
    event: input.hook_event_name,
    session: input.session_id,
    prompt: input.prompt_id,
    tool: input.tool_name,
    call: input.tool_use_id,
    native: input,
    pid: Deno.pid,
    parent: Deno.ppid,
  }) + "\n",
  { append: true, mode: 0o600 },
);
