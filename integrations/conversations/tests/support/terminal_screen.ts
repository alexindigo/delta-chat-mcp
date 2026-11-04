// SPDX-License-Identifier: LGPL-3.0-only
// Run in the guest with an evidence-local Deno config/lock. This optional TUI
// observer dependency belongs to qualification, not the backend runtime graph.
const specifier = "npm:@xterm/headless@5.5.0";
const imported = await import(specifier);
const xterm = imported.default ?? imported;
const terminal = new xterm.Terminal({
  cols: 120,
  rows: 40,
  allowProposedApi: true,
  logLevel: "off",
});
const bytes = await Deno.readFile(Deno.args[0]);
await new Promise<void>((resolve) => terminal.write(bytes, resolve));
const buffer = terminal.buffer.active;
console.log(JSON.stringify({
  screen: Array.from(
    { length: buffer.length },
    (_, i) => buffer.getLine(i)?.translateToString(true) ?? "",
  ).join("\n"),
  cursor: { x: buffer.cursorX, y: buffer.cursorY },
}));
terminal.dispose();
