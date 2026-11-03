// SPDX-License-Identifier: LGPL-3.0-only
// C24b: both factories are actual byte-identical bundles at distinct file URLs,
// imported by the main plugin isolate (pinned plugin/loader.ts import(entry)).
import { appendFileSync } from "node:fs";
import type { Foundation } from "../../mod.ts";

export default async function probe(input: unknown, options: {
  artifacts: string[];
  log: string;
  stateFile: string;
}) {
  const hooks: {
    config(config: unknown): void | Promise<void>;
    dispose(): Promise<void>;
  }[] = [];
  for (const [index, artifact] of options.artifacts.entries()) {
    const module = await import(artifact);
    hooks.push(
      await module.default(input, {
        relays: {},
        stateFile: options.stateFile,
      }, {
        attach(f: Foundation) {
          const descriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            Symbol.for("delta-chat-mcp.opencode-wake.process.v1"),
          );
          appendFileSync(
            options.log,
            JSON.stringify({
              index,
              epoch: f.epoch,
              nonreplaceable: descriptor?.writable === false &&
                descriptor?.configurable === false &&
                Object.isFrozen(descriptor?.value),
            }) + "\n",
          );
          return {};
        },
      }),
    );
  }
  return {
    async config(config: unknown) {
      for (const hook of hooks) await hook.config(config);
    },
    async dispose() {
      for (const hook of hooks) await hook.dispose();
    },
  };
}
