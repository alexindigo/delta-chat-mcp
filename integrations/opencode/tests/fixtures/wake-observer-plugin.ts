// SPDX-License-Identifier: LGPL-3.0-only
// Same test-only factory injection pattern as the accepted bundle-probe-plugin.
// Observes owned transport counts, never drives watchers or fabricates events.
import { writeFileSync } from "node:fs";
import type { Foundation } from "../../mod.ts";
import { object } from "../../types.ts";
import type { RegistryWriter } from "../../registry.ts";

export default async function observer(input: unknown, options: unknown) {
  const settings = object(options);
  const log = String(settings.observerLog);
  const product = { ...settings };
  delete product.observerLog;
  const module = await import(
    new URL("../../dist/delta-chat-mcp-opencode.js", import.meta.url).href
  );
  const metrics = {
    nativeCalls: {} as Record<string, number>,
    registryWrites: 0,
    events: {} as Record<string, number>,
    notifications: [] as { message: string }[],
    acceptedToasts: 0,
  };
  const client = object(object(input).client);
  for (
    const [groupName, names] of Object.entries({
      session: ["get", "status", "messages", "message", "promptAsync"],
      mcp: ["status"],
      tui: ["showToast"],
    })
  ) {
    const group = object(client[groupName]);
    for (const name of names) {
      const original = group[name];
      if (typeof original !== "function") {
        throw new Error("Unsupported fixture native API");
      }
      group[name] = async (options: unknown) => {
        const key = `${groupName}.${name}`;
        metrics.nativeCalls[key] = (metrics.nativeCalls[key] ?? 0) + 1;
        if (key === "tui.showToast") {
          const response = await fetch(
            `${process.env.DCMCP_DELAY_URL}/toast/toast_${crypto.randomUUID()}`,
            { method: "POST", signal: object(options).signal as AbortSignal },
          );
          await response.body?.cancel();
        }
        const response = await Reflect.apply(original, group, [options]);
        if (key === "tui.showToast" && object(response).data === true) {
          metrics.acceptedToasts++;
        }
        return response;
      };
    }
  }
  let foundation: Foundation | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const snapshot = () => {
    if (!foundation) return;
    writeFileSync(
      log,
      JSON.stringify({
        epoch: foundation.epoch,
        metrics,
        relays: [...foundation.relays].map(([alias, relay]) => ({
          alias,
          connections: relay.connectionCount,
          connecting: relay.connectingCount,
          cleanupFailures: relay.cleanupFailures,
          health: relay.health.state,
          enabled: relay.config.enabled,
        })),
      }),
    );
  };
  const hooks = await module.default(input, product, {
    attach(f: Foundation) {
      foundation = f;
      const registry = f.registry;
      const write = registry.write;
      registry.write = function <T>(run: (tx: RegistryWriter) => T): T {
        metrics.registryWrites++;
        return write.call(this, run) as T;
      };
      return {
        event(input: unknown) {
          const event = object(object(input).event);
          const type = String(event.type);
          metrics.events[type] = (metrics.events[type] ?? 0) + 1;
          if (type === "tui.toast.show") {
            const props = object(event.properties);
            if (
              typeof props.message === "string" &&
              props.message.startsWith("delta-chat-mcp:")
            ) metrics.notifications.push({ message: props.message });
          }
        },
      };
    },
  });
  return {
    ...hooks,
    async "chat.message"(
      input: { messageID?: string },
      output: { parts: { metadata?: Record<string, unknown> }[] },
    ) {
      if (!output.parts.some((p) => p.metadata?.deltaChatWake)) return;
      const response = await fetch(
        `${process.env.DCMCP_DELAY_URL}/wake/${input.messageID}`,
        { method: "POST" },
      );
      await response.body?.cancel();
      if (!response.ok) throw new Error("j4-deliberate-admission-error");
    },
    async config(config: unknown) {
      await hooks.config(config);
      timer = setInterval(snapshot, 100);
    },
    async dispose() {
      clearInterval(timer);
      await hooks.dispose();
      snapshot();
    },
  };
}
