// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OpenCode } from "../../integrations/opencode/opencode.ts";
import type { NativeMessage } from "../../integrations/opencode/types.ts";

Deno.test("selection model and variant share one source, never an older message's variant", () => {
  const oc = new OpenCode({});
  const latest: NativeMessage = {
    info: {
      id: "msg_old",
      role: "user",
      agent: "old-agent",
      model: {
        providerID: "old-provider",
        modelID: "old-model",
        variant: "careful",
      },
      time: { created: 1 },
    },
    parts: [],
  };
  assertEquals(
    oc.selection({
      id: "ses_current",
      agent: "selected",
      model: { providerID: "test", id: "current-model" },
    }, latest),
    {
      agent: "selected",
      model: { providerID: "test", modelID: "current-model" },
      variant: "default",
    },
  );
  assertEquals(
    oc.selection({
      id: "ses_current",
      agent: "selected",
      model: { providerID: "test", id: "current-model", variant: "default" },
    }, latest),
    {
      agent: "selected",
      model: { providerID: "test", modelID: "current-model" },
      variant: "default",
    },
  );
  assertEquals(oc.selection({ id: "ses_current", agent: "selected" }, latest), {
    agent: "selected",
    model: { providerID: "old-provider", modelID: "old-model" },
    variant: "careful",
  });
  assertEquals(
    oc.selection({
      id: "ses_current",
      model: { providerID: "test", id: "current-model", variant: "fresh" },
    }, latest),
    {
      agent: "old-agent",
      model: { providerID: "test", modelID: "current-model" },
      variant: "fresh",
    },
  );
});
