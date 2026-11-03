// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { poll } from "../../../../tests/support.ts";
import { ProviderFixture } from "./provider_fixture.ts";
import { McpFixture } from "./mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./opencode_process.ts";

const ids = () => ({
  message: `msg_j2${crypto.randomUUID().replaceAll("-", "")}`,
  part: `prt_j2${crypto.randomUUID().replaceAll("-", "")}`,
});
const model = { providerID: "test", modelID: "test-model" };

// Pinned source: prompt.ts:646–685 and llm/request.ts:80–91. Characterize
// native behavior first; the explicit-default adapter branch is not guessed.
export async function selectionWorld(bundle = false) {
  const provider = new ProviderFixture();
  const mcp = new McpFixture();
  const delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  const config = provider.config();
  const models = config.provider.test.models as Record<
    string,
    { variants: Record<string, unknown> }
  >;
  models["test-model"].variants = { careful: { reasoningEffort: "high" } };
  await oc.configure({
    ...config,
    agent: {
      selected: {
        mode: "primary",
        model: "test/test-model",
        variant: "careful",
        description: "J2 configured variant",
      },
    },
    ...(bundle
      ? {
        plugin: [
          [
            new URL("../../dist/delta-chat-mcp-opencode.js", import.meta.url)
              .href,
            {
              relays: {},
              stateFile: `${oc.root}/state/wake.sqlite`,
            },
          ],
          [
            new URL("../fixtures/bundle-probe-plugin.ts", import.meta.url).href,
            {
              relays: {},
              stateFile: `${oc.root}/state/wake.sqlite`,
            },
          ],
        ],
      }
      : {}),
  });
  const seed = async (title: string) => {
    const session = await oc.session(title);
    const native = ids();
    await oc.prompt(session.id, {
      messageID: native.message,
      agent: "selected",
      model,
      variant: "default",
      noReply: true,
      parts: [{ id: native.part, type: "text", text: "C7b seed default" }],
    });
    await poll(async () => !!await oc.found(session.id, native.message));
    const before = await oc.api(`/session/${session.id}`);
    assertEquals(before.agent, "selected");
    assertEquals(before.model, {
      id: "test-model",
      providerID: "test",
      variant: "default",
    });
    return { session: session.id, before };
  };
  const close = async () => {
    await oc.close();
    await delay.close();
    await mcp.close();
    await provider.close();
  };
  return { provider, oc, seed, close };
}

export async function runSelectionContract() {
  const f = await selectionWorld();
  try {
    const version = await f.oc.version();
    await f.oc.start();
    const turn = async (variant?: string) => {
      const seeded = await f.seed(
        variant === undefined
          ? "omitted variant control"
          : "explicit default characterization",
      );
      const native = ids();
      f.provider.queue.push({ text: "C7b native answer" });
      await f.oc.prompt(seeded.session, {
        messageID: native.message,
        agent: "selected",
        model,
        ...(variant === undefined ? {} : { variant }),
        parts: [{
          id: native.part,
          type: "text",
          text: "C7b native comparison",
        }],
      });
      await f.oc.final(seeded.session, native.message);
      return {
        ...seeded,
        after: await f.oc.api(`/session/${seeded.session}`),
        stored: await f.oc.found(seeded.session, native.message),
        request: f.provider.requests.at(-1)!,
      };
    };
    const omitted = await turn();
    const explicit = await turn("default");
    assertEquals(omitted.stored!.info.model?.variant, "careful");
    assertEquals(
      (omitted.after.model as Record<string, unknown>).variant,
      "careful",
    );
    assertEquals(explicit.stored!.info.model?.variant, "default");
    assertEquals(explicit.after.agent, explicit.before.agent);
    assertEquals(explicit.after.model, explicit.before.model);
    // Observe the actual provider's wire spelling instead of assuming a SDK
    // option mapping. The positive control must expose our configured marker.
    const variantFields = Object.keys(omitted.request).filter((key) =>
      omitted.request[key] === "high"
    );
    assert(
      variantFields.length > 0,
      "Configured variant must reach the provider in the omission control",
    );
    assertEquals(variantFields, ["reasoning_effort"]);
    for (const key of variantFields) assert(explicit.request[key] !== "high");
    assertEquals(f.provider.requests.length, 2);
    assertEquals(f.provider.unexpected, []);
    const proof = {
      time: new Date().toISOString(),
      contract: "C7b-native",
      version,
      result: "PASS",
      state: f.oc.root,
      omittedVariant: omitted.stored!.info.model?.variant,
      explicitVariant: explicit.stored!.info.model?.variant,
      before: explicit.before.model,
      after: explicit.after.model,
      providerVariantFields: variantFields,
      defaultExcludesAgentVariant: true,
      providerRequests: 2,
    };
    console.log(JSON.stringify(proof));
    await Deno.writeTextFile(
      `${f.oc.root}/C7b-native.json`,
      JSON.stringify(proof),
      { mode: 0o600 },
    );
  } finally {
    await f.close();
  }
  await runBundledSelectionContract();
}

async function runBundledSelectionContract() {
  const f = await selectionWorld(true);
  try {
    const version = await f.oc.version();
    await f.oc.start();
    const target = await f.seed("bundle preserves explicit default");
    const control = await f.oc.session("bundle selection control");
    const submission = ids(), trigger = ids();
    const marker = "C7b actual bundled adapter target input";
    f.provider.queue.push(
      {
        tool: {
          name: "j2_foundation",
          args: {
            action: "preserve-selection",
            target: target.session,
            messageID: submission.message,
            partID: submission.part,
            text: marker,
          },
        },
      },
      { text: "C7b completed" },
      { text: "C7b completed" },
    );
    await f.oc.prompt(control.id, {
      messageID: trigger.message,
      agent: "build",
      model,
      variant: "default",
      parts: [{
        id: trigger.part,
        type: "text",
        text: "Invoke the fixture selection adapter",
      }],
    });
    await Promise.all([
      f.oc.final(target.session, submission.message),
      f.oc.final(control.id, trigger.message),
    ]);
    const tool = (await f.oc.messages(control.id)).flatMap((row) => row.parts)
      .find((part) => part.tool === "j2_foundation");
    assertEquals(tool?.state?.status, "completed");
    const facts = JSON.parse(tool!.state!.output!);
    assertEquals(facts.selection, {
      agent: "selected",
      model,
      variant: "default",
    });
    const after = await f.oc.api(`/session/${target.session}`);
    assertEquals(after.agent, target.before.agent);
    assertEquals(after.model, target.before.model);
    const stored = await f.oc.found(target.session, submission.message);
    assertEquals(stored!.info.agent, "selected");
    assertEquals(stored!.info.model, { ...model, variant: "default" });
    assertEquals(stored!.parts[0].metadata, { j2SelectionProbe: true });
    const requests = f.provider.requests.filter((request) =>
      (request.messages as { role: string; content: unknown }[]).some((
        message,
      ) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes(marker)
      )
    );
    assertEquals(requests.length, 1);
    assert(requests[0].reasoning_effort !== "high");
    assertEquals(f.provider.requests.length, 3);
    assertEquals(f.provider.unexpected, []);
    const proof = {
      time: new Date().toISOString(),
      contract: "C7b-bundle",
      version,
      result: "PASS",
      state: f.oc.root,
      target: target.session,
      messageID: submission.message,
      partID: submission.part,
      selection: facts.selection,
      before: target.before.model,
      after: after.model,
      providerRequests: 3,
      targetProviderRequests: 1,
      defaultExcludesAgentVariant: true,
      actualBundledSubmit: true,
    };
    console.log(JSON.stringify(proof));
    await Deno.writeTextFile(
      `${f.oc.root}/C7b-bundle.json`,
      JSON.stringify(proof),
      { mode: 0o600 },
    );
  } finally {
    await f.close();
  }
}
