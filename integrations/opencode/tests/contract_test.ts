// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { poll } from "../../../tests/support.ts";
import { ProviderFixture } from "./support/provider_fixture.ts";
import { McpFixture } from "./support/mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./support/opencode_process.ts";
import { runJ2Contracts } from "./support/j2_contracts.ts";
import { runSelectionContract } from "./support/j2_selection_contracts.ts";
// The shared offline contract uses the product Relay adapter and real composed
// relay; importing registers the same C25 in each pin's contract invocation.
import "../../../tests/unit/opencode_relay_test.ts";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const nativeIDs = () => ({
  message: `msg_j0${crypto.randomUUID().replaceAll("-", "")}`,
  part: `prt_j0${crypto.randomUUID().replaceAll("-", "")}`,
});
const model = { providerID: "test", modelID: "test-model" };
Deno.test("J2 real bundle C2 and K1 (A-J2-5)", runJ2Contracts);
Deno.test(
  "J2 C7b configured agent variant and explicit default selection",
  runSelectionContract,
);
function payload(
  text: string,
  ids = nativeIDs(),
  extra: Record<string, unknown> = {},
) {
  return {
    messageID: ids.message,
    model,
    parts: [{ id: ids.part, type: "text", text }],
    ...extra,
  };
}

Deno.test("J0 real pinned OpenCode contracts (C25/J2 and C27/J6 excluded)", async (t) => {
  const provider = new ProviderFixture();
  const mcp = new McpFixture();
  const delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  let version = "unread";
  const releases: (() => void)[] = [];
  const proof = async (
    contract: string,
    facts: Record<string, unknown>,
    branch = false,
  ) => {
    const row = {
      time: new Date().toISOString(),
      contract,
      version,
      result: branch ? "BRANCH" : "PASS",
      ...facts,
    };
    await Deno.writeTextFile(
      `${oc.root}/contracts.jsonl`,
      JSON.stringify(row) + "\n",
      { append: true, mode: 0o600 },
    );
    console.log(JSON.stringify(row));
  };
  const step = async (id: string, run: () => Promise<void>) => {
    if (!await t.step(id, run)) {
      throw new Error(
        `${id} characterization failed; stop for parent review (state ${oc.root})`,
      );
    }
  };
  const turn = async (
    title: string,
    tool: { name: string; args: Record<string, unknown> },
    directory = oc.directory,
  ) => {
    const session = await oc.session(title, directory);
    provider.queue.push({ tool }, { text: `${title}-final` });
    const ids = nativeIDs();
    await oc.prompt(session.id, payload(title, ids), directory);
    const answer = await oc.final(session.id, ids.message, directory);
    return {
      session: session.id,
      ids,
      answer,
      rows: await oc.messages(session.id, directory),
    };
  };

  try {
    await step("C1 pinned artifact identity", async () => {
      version = await oc.version();
      const hashes: Record<string, { archive: string; executable: string }> = {
        "1.18.35": {
          archive:
            "c8f888b451f5494a18f858fffb0e0b68f4e4baa9c241761c5f206884f0fa640d",
          executable:
            "77b2cfe4b97df6f15c3673b22100b9f79c711f25ecb9bf513bb82526b15d24fa",
        },
        "1.19.3": {
          archive:
            "13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b",
          executable:
            "179ca421d61eefeadfa0c50e084a6e79c1623734732f0f4593f81ccfd3ab7ee9",
        },
      };
      assert(hashes[version], "Only the two characterized pins are supported");
      const hash = async (path: string) =>
        [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", await Deno.readFile(path)),
          ),
        ].map((n) => n.toString(16).padStart(2, "0")).join("");
      const archive = await hash(
        oc.binary.replace(/opencode$/, "opencode-linux-x64.tar.gz"),
      );
      const executable = await hash(oc.binary);
      assertEquals({ archive, executable }, hashes[version]);
      await proof("C1", { archive, executable, state: oc.root });
    });

    await step("C10 lazy serve and persistent directory instance", async () => {
      await oc.start();
      assertEquals(
        (await oc.rows()).length,
        0,
        "Global health must not load project plugin",
      );
      await oc.api("/session/status");
      await oc.waitRow((row) => row.kind === "init");
      await oc.api("/session/status");
      const inits = (await oc.rows()).filter((row) => row.kind === "init");
      assertEquals(inits.length, 1);
      await proof("C10", {
        lazy: true,
        loadsAfterTwoGets: inits.length,
        instancePersists: true,
      });
    });

    await step(
      "C2 file plugin resolved config and JSON-schema context",
      async () => {
        const config = await oc.waitRow((row) => row.kind === "config");
        assertEquals(config.resolvedUrl, true);
        assertEquals(config.resolvedHeader, true);
        const result = await turn("schema-context", {
          name: "j0_probe",
          args: { action: "context" },
        });
        const tool = await oc.waitRow((row) =>
          row.kind === "tool" && row.sessionID === result.session
        );
        const part = result.rows.flatMap((m) => m.parts).find((p) =>
          p.type === "tool" && p.tool === "j0_probe"
        );
        assertEquals(part?.state?.status, "completed");
        assertStringIncludes(part!.state!.output!, result.session);
        assertStringIncludes(
          JSON.stringify(provider.requests.at(-1)),
          result.session,
        );
        await proof("C2", {
          sessionID: tool.sessionID,
          resolvedUrl: true,
          resolvedHeader: true,
          toolPart: part!.id,
          consumerSawSessionID: true,
          plugin: "single-file probe; real product bundle gate reserved J2",
        });
      },
    );

    await step(
      "C3 raw MCP after-hook and appended provider notice",
      async () => {
        const result = await turn("raw-result", {
          name: "fixture_send_message",
          args: { text: "C3" },
        });
        const row = await oc.waitRow((row) =>
          row.kind === "after" &&
          (row.call as Record<string, unknown>)?.sessionID === result.session &&
          (row.call as Record<string, unknown>)?.tool === "fixture_send_message"
        );
        const raw = row.output as Record<string, unknown>;
        assert(Array.isArray(raw.content));
        assertEquals(raw.structuredContent, {
          message_id: 101,
          chat_id: 42,
          state: "sent",
        });
        const noticeVisible = JSON.stringify(provider.requests.at(-1)).includes(
          "J0_APPENDED_NOTICE",
        );
        await proof("C3", {
          sessionID: result.session,
          call: row.call,
          raw,
          noticeVisible,
          nextRequest: provider.requests.length,
        }, !noticeVisible);
      },
    );

    await step("C4 isError hook behavior", async () => {
      const result = await turn("iserror", {
        name: "fixture_send_message",
        args: { text: "C4", mode: "error" },
      });
      const afters = (await oc.rows()).filter((row) =>
        row.kind === "after" &&
        (row.call as Record<string, unknown>)?.sessionID === result.session &&
        (row.call as Record<string, unknown>)?.tool === "fixture_send_message"
      );
      const parts = result.rows.flatMap((m) => m.parts).filter((p) =>
        p.tool === "fixture_send_message"
      );
      assertEquals(parts.length, 1);
      await proof("C4", {
        sessionID: result.session,
        afterCount: afters.length,
        toolState: parts[0].state,
      }, true);
    });

    await step("C5 throwing after-hook behavior", async () => {
      const calls = mcp.calls.length;
      const result = await turn("after-throw", {
        name: "fixture_send_message",
        args: { text: "C5", mode: "throw" },
      });
      assertEquals(mcp.calls.length, calls + 1);
      const part = result.rows.flatMap((m) => m.parts).find((p) =>
        p.tool === "fixture_send_message"
      );
      assert(part);
      await proof("C5", {
        sessionID: result.session,
        remoteCalls: 1,
        partID: part.id,
        toolState: part.state,
      }, true);
    });

    await step(
      "C7 metadata and explicit agent/model/custom variant preservation",
      async () => {
        const session = await oc.session("selection");
        const ids = nativeIDs();
        const metadata = {
          deltaChatWake: { v: 1, deliveryId: "j0-selection", messageIds: [7] },
        };
        const body = {
          messageID: ids.message,
          noReply: true,
          agent: "selected",
          model,
          variant: "careful",
          parts: [{ id: ids.part, type: "text", text: "C7", metadata }],
        };
        await oc.prompt(session.id, body);
        await poll(async () => !!await oc.found(session.id, ids.message));
        const stored = (await oc.found(session.id, ids.message))!;
        assertEquals(stored.parts[0].metadata, metadata);
        assertEquals(stored.info.agent, "selected");
        assertEquals(stored.info.model, { ...model, variant: "careful" });
        const selection = await oc.api(`/session/${session.id}`);
        const ids2 = nativeIDs();
        await oc.prompt(session.id, {
          ...body,
          messageID: ids2.message,
          parts: [{ id: ids2.part, type: "text", text: "C7-preserve" }],
        });
        await poll(async () => !!await oc.found(session.id, ids2.message));
        const preserved = await oc.api(`/session/${session.id}`);
        assertEquals(preserved.agent, selection.agent);
        assertEquals(preserved.model, selection.model);
        const omitted = nativeIDs();
        await oc.prompt(
          session.id,
          payload("C7-omit-agent", omitted, { noReply: true }),
        );
        await poll(async () => !!await oc.found(session.id, omitted.message));
        const changed = await oc.api(`/session/${session.id}`);
        assertEquals(changed.agent, "build");
        await proof("C7", {
          sessionID: session.id,
          messageID: ids.message,
          partID: ids.part,
          metadata: stored.parts[0].metadata,
          selected: { agent: selection.agent, model: selection.model },
          preserved: { agent: preserved.agent, model: preserved.model },
          omitted: { agent: changed.agent, model: changed.model },
          variantSchema:
            "v1.18.35 packages/core/src/v1/config/provider.ts:69-79 (via src/config/config.ts ConfigV1)",
        });
      },
    );

    await step("C11 password server and authenticated plugin SDK", async () => {
      const response = await oc.raw(
        "/session/status",
        "GET",
        undefined,
        oc.directory,
        false,
      );
      assertEquals(response.status, 401);
      await response.body?.cancel();
      const result = await turn("client-auth", {
        name: "j0_probe",
        args: { action: "status" },
      });
      const client = await oc.waitRow((row) => row.kind === "client");
      assertEquals(client.ok, true);
      await proof("C11", {
        sessionID: result.session,
        unauthenticatedStatus: 401,
        pluginClientSucceeded: true,
      });
    });

    await step("C12 directory override loads second instance", async () => {
      assertEquals(
        (await oc.rows()).filter((r) =>
          r.kind === "init" && r.directory === oc.otherDirectory
        ).length,
        0,
      );
      await turn("cross-directory", {
        name: "j0_probe",
        args: { action: "cross", directory: oc.otherDirectory },
      });
      await oc.waitRow((r) =>
        r.kind === "init" && r.directory === oc.otherDirectory
      );
      const cross = await oc.waitRow((r) => r.kind === "cross");
      assertEquals(cross.ok, true);
      await proof("C12", {
        from: oc.directory,
        target: oc.otherDirectory,
        pluginClientOverrideSucceeded: true,
      });
    });

    await step(
      "C9 directory-filtered status idle and part events",
      async () => {
        const other = await oc.session("directory-b", oc.otherDirectory);
        provider.queue.push({ text: "C9-directory-b-answer" });
        const ids = nativeIDs();
        await oc.prompt(other.id, payload("C9-B", ids), oc.otherDirectory);
        await oc.final(other.id, ids.message, oc.otherDirectory);
        const hasSession = (properties: Record<string, unknown>) =>
          properties.sessionID === other.id ||
          (properties.part as Record<string, unknown>)?.sessionID === other.id;
        await oc.waitRow((r) =>
          r.kind === "event" && r.directory === oc.otherDirectory &&
          r.type === "session.idle" &&
          hasSession(r.properties as Record<string, unknown>)
        );
        const rows = (await oc.rows()).filter((r) => r.kind === "event");
        const matching = rows.filter((r) =>
          hasSession(r.properties as Record<string, unknown>)
        );
        assert(matching.length > 0);
        assert(matching.every((r) => r.directory === oc.otherDirectory));
        const types = [
          ...new Set(
            rows.filter((r) => r.directory === oc.directory).map((r) => r.type),
          ),
        ];
        for (
          const type of [
            "session.status",
            "session.idle",
            "message.part.updated",
          ]
        ) {
          assert(types.includes(type));
        }
        await proof("C9", {
          otherSession: other.id,
          otherEventCount: matching.length,
          crossDirectoryLeaks: 0,
          observedTypes: types,
        });
      },
    );

    await step("C13 plugin-runtime SQLite", async () => {
      const row = await oc.waitRow((r) => r.kind === "init");
      assert(["node:sqlite", "bun:sqlite"].includes(String(row.sqlite)));
      await proof("C13", { sqlite: row.sqlite, queryResult: 37 });
    });

    await step("C15 noReply persists with no provider call", async () => {
      const session = await oc.session("noReply");
      const before = provider.requests.length;
      const ids = nativeIDs();
      await oc.prompt(
        session.id,
        payload("C15-notice", ids, { noReply: true }),
      );
      await poll(async () => !!await oc.found(session.id, ids.message));
      await oc.api("/session/status");
      assertEquals(provider.requests.length, before);
      await proof("C15", {
        sessionID: session.id,
        messageID: ids.message,
        partID: ids.part,
        providerDelta: 0,
      });
    });

    await step("C14 revert visibility", async () => {
      const session = await oc.session("revert");
      const first = nativeIDs(), second = nativeIDs();
      await oc.prompt(
        session.id,
        payload("C14-first", first, { noReply: true }),
      );
      await poll(async () => !!await oc.found(session.id, first.message));
      await oc.prompt(
        session.id,
        payload("C14-second", second, { noReply: true }),
      );
      await poll(async () => !!await oc.found(session.id, second.message));
      await oc.api(`/session/${session.id}/revert`, "POST", {
        messageID: second.message,
      });
      const info = await oc.api(`/session/${session.id}`);
      await proof("C14", {
        sessionID: session.id,
        requested: second.message,
        revert: info.revert ?? null,
      }, true);
    });

    await step("C17 toast without TUI", async () => {
      await turn("toast", { name: "j0_probe", args: { action: "toast" } });
      const toast = await oc.waitRow((r) => r.kind === "toast");
      await proof("C17", { ok: toast.ok }, true);
    });

    await step("C18 unknown session", async () => {
      const response = await oc.raw(
        "/session/ses_j0nonexistent",
        "GET",
        undefined,
        oc.directory,
      );
      const status = response.status;
      await response.body?.cancel();
      await proof("C18", { status }, true);
    });

    await step("C8 busy prompt join and late-message processing", async () => {
      const session = await oc.session("busy");
      const release = Promise.withResolvers<void>();
      releases.push(release.resolve);
      const before = provider.requests.length;
      provider.queue.push({ text: "C8-first", hold: release.promise }, {
        text: "C8-late",
      });
      const first = nativeIDs(), late = nativeIDs();
      await oc.prompt(session.id, payload("C8-held-turn", first));
      await poll(() => provider.requests.length === before + 1);
      await oc.prompt(session.id, payload("C8-late-message", late));
      await poll(async () => !!await oc.found(session.id, late.message));
      assertEquals(provider.requests.length, before + 1);
      release.resolve();
      await oc.final(session.id);
      const rows = await oc.messages(session.id);
      const parents = rows.filter((m) => m.info.role === "assistant").map((m) =>
        m.info.parentID
      );
      const providerDelta = provider.requests.length - before;
      provider.queue.splice(0); // The optional late turn is precisely this recorded branch.
      await proof("C8", {
        sessionID: session.id,
        first: first.message,
        late: late.message,
        persistedWhileBusy: true,
        assistantParents: parents,
        providerDelta,
        lateProcessed: parents.includes(late.message),
      }, true);
    });

    await step("C16 abort assistant error", async () => {
      const session = await oc.session("abort");
      const release = Promise.withResolvers<void>();
      releases.push(release.resolve);
      const before = provider.requests.length;
      provider.queue.push({
        hold: release.promise,
        text: "C16-should-be-aborted",
      });
      await oc.prompt(session.id, payload("C16-abort"));
      await poll(() => provider.requests.length === before + 1);
      await oc.api(`/session/${session.id}/abort`, "POST");
      await poll(async () => {
        const status = await oc.api<Record<string, { type: string }>>(
          "/session/status",
        );
        return !status[session.id] || status[session.id].type === "idle";
      });
      release.resolve();
      const rows = await oc.messages(session.id);
      await proof("C16", {
        sessionID: session.id,
        assistantErrors: rows.filter((m) => m.info.role === "assistant").map((
          m,
        ) => m.info.error ?? null),
      }, true);
    });

    await step(
      "C20 same IDs before persistence, unanswered, after answer",
      async () => {
        const observations = [];
        for (
          const mode of ["before-persistence", "unanswered", "after-answer"]
        ) {
          const session = await oc.session(`same-id-${mode}`);
          const ids = nativeIDs();
          const before = provider.requests.length;
          const body = payload(`C20-${mode}`, ids);
          const release = Promise.withResolvers<void>();
          releases.push(release.resolve);
          provider.queue.push({
            text: `C20-${mode}-original-answer`,
            ...(mode === "unanswered" ? { hold: release.promise } : {}),
          }, { text: `C20-${mode}-repeat-answer` });
          let originalCreated: number | undefined;
          if (mode === "before-persistence") {
            body.parts[0] = {
              ...body.parts[0],
              ...{ metadata: { j0Hold: true } },
            };
            await oc.prompt(session.id, body);
            await poll(() => (delay.held.get(ids.message)?.length ?? 0) === 1);
            await oc.prompt(session.id, body);
            await poll(() => (delay.held.get(ids.message)?.length ?? 0) === 2);
            assertEquals(await oc.found(session.id, ids.message), undefined);
            delay.release(ids.message);
          } else {
            await oc.prompt(session.id, body);
            await poll(async () => !!await oc.found(session.id, ids.message));
            originalCreated =
              (await oc.found(session.id, ids.message))!.info.time.created;
            if (mode === "after-answer") {
              await oc.final(session.id, ids.message);
            }
            if (mode === "unanswered") {
              await poll(() => provider.requests.length === before + 1);
              const status = await oc.api<Record<string, { type: string }>>(
                "/session/status",
              );
              assertEquals(status[session.id]?.type, "busy");
            }
            await pause(25); // Cross the Date.now resolution; F22 rewrites this value.
            await oc.prompt(session.id, body);
          }
          await poll(async () => !!await oc.found(session.id, ids.message));
          if (originalCreated !== undefined) {
            await poll(async () =>
              (await oc.found(session.id, ids.message))!.info.time.created >
                originalCreated!
            );
          }
          if (mode === "unanswered") {
            assertEquals(provider.requests.length, before + 1);
            release.resolve();
          }
          await oc.final(session.id, ids.message);
          // Observe the completed normal loop, including optional repeat execution.
          await pause(1_000);
          await oc.final(session.id, ids.message);
          assert(
            provider.requests.length > before,
            "Every timing window must execute a normal provider turn",
          );
          provider.queue.splice(0); // Only an unconsumed optional repeat branch.
          const rows = await oc.messages(session.id);
          const users = rows.filter((m) => m.info.role === "user");
          assertEquals(users.length, 1, "NO-GO: duplicate native message row");
          assertEquals(users[0].info.id, ids.message);
          assertEquals(
            users[0].parts.length,
            1,
            "NO-GO: duplicate native part row",
          );
          assertEquals(users[0].parts[0].id, ids.part);
          observations.push({
            mode,
            normalReplyLoop: true,
            providerHeldBeforeRepeat: mode === "unanswered",
            sessionID: session.id,
            messageID: ids.message,
            partID: ids.part,
            messageRows: users.length,
            partRows: users[0].parts.length,
            originalCreated,
            timeCreated: users[0].info.time.created,
            assistantTimes: rows.filter((m) => m.info.role === "assistant").map(
              (m) => m.info.time.created,
            ),
            providerDelta: provider.requests.length - before,
          });
        }
        await proof("C20", { observations });
      },
    );

    await step(
      "C21 original persists after 204 and negative lookup past bound",
      async () => {
        const session = await oc.session("delayed-original");
        const ids = nativeIDs();
        const before = provider.requests.length;
        provider.queue.push({ text: "C21-answer" });
        await oc.prompt(session.id, {
          messageID: ids.message,
          model,
          parts: [{
            id: ids.part,
            type: "text",
            text: "C21",
            metadata: { j0Hold: true },
          }],
        });
        await poll(() => delay.held.has(ids.message));
        const heldAt = Date.now();
        await pause(6_000);
        assertEquals(await oc.found(session.id, ids.message), undefined);
        delay.release(ids.message);
        await oc.final(session.id, ids.message);
        const row = await oc.found(session.id, ids.message);
        assert(row);
        assertEquals(row.parts.length, 1);
        await proof("C21", {
          sessionID: session.id,
          messageID: ids.message,
          partID: ids.part,
          heldMs: Date.now() - heldAt,
          negativeLookupAfter204: true,
          persistedAfterRelease: true,
          providerDelta: provider.requests.length - before,
        });
      },
    );

    await step(
      "C22 crash before persistence and 60-second post-restart absence",
      async () => {
        const session = await oc.session("crashed-original");
        const ids = nativeIDs();
        await oc.prompt(session.id, {
          messageID: ids.message,
          model,
          parts: [{
            id: ids.part,
            type: "text",
            text: "C22",
            metadata: { j0Hold: true },
          }],
        });
        await poll(() => delay.held.has(ids.message));
        assertEquals(await oc.found(session.id, ids.message), undefined);
        await oc.stop("SIGKILL");
        delay.release(ids.message);
        await oc.start();
        const start = Date.now();
        let lookups = 0;
        while (Date.now() - start < 60_000) {
          assertEquals(await oc.found(session.id, ids.message), undefined);
          lookups++;
          await pause(1_000);
        }
        assertEquals(await oc.found(session.id, ids.message), undefined);
        await proof("C22", {
          sessionID: session.id,
          messageID: ids.message,
          partID: ids.part,
          originalExited: true,
          observationMs: Date.now() - start,
          negativeLookups: lookups + 1,
          providerRequests: provider.requests.length,
        });
      },
    );

    await step(
      "C23 native MCP disable/connect and per-directory state",
      async () => {
        const connected = await oc.api<Record<string, { status: string }>>(
          "/mcp",
        );
        assertEquals(connected.fixture.status, "connected");
        await oc.api("/mcp", "GET", undefined, oc.otherDirectory);
        await oc.api("/mcp/fixture/disconnect", "POST");
        const disabled = await oc.api<Record<string, { status: string }>>(
          "/mcp",
        );
        const other = await oc.api<Record<string, { status: string }>>(
          "/mcp",
          "GET",
          undefined,
          oc.otherDirectory,
        );
        assertEquals(disabled.fixture.status, "disabled");
        assertEquals(other.fixture.status, "connected");
        await oc.api("/mcp/fixture/connect", "POST");
        assertEquals(
          (await oc.api<Record<string, { status: string }>>("/mcp")).fixture
            .status,
          "connected",
        );
        await oc.stop();
        await oc.configure({
          mcp: {
            fixture: {
              type: "remote",
              url: "{env:DCMCP_TEST_MCP_URL}",
              oauth: false,
              headers: { Authorization: "Bearer {env:DCMCP_TEST_MCP_TOKEN}" },
              enabled: false,
            },
          },
        });
        await oc.start();
        const configDisabled = await oc.api<Record<string, { status: string }>>(
          "/mcp",
        );
        assertEquals(configDisabled.fixture.status, "disabled");
        await proof("C23", {
          connected: connected.fixture.status,
          disconnected: disabled.fixture.status,
          otherDirectory: other.fixture.status,
          reconnected: "connected",
          configEnabledFalse: configDisabled.fixture.status,
        });
      },
    );

    await step(
      "C24 server URL, module epoch and global disposal events",
      async () => {
        const first = await oc.waitRow((r) => r.kind === "init");
        assertEquals(first.serverUrl, oc.serverUrl);
        const stream = await oc.events();
        try {
          await poll(() => stream.rows.length > 0);
          const count = (await oc.rows()).filter((r) =>
            r.kind === "init"
          ).length;
          await oc.api("/instance/dispose", "POST");
          await poll(async () =>
            (await oc.rows()).some((r) =>
              r.kind === "dispose" && r.epoch === first.epoch
            )
          );
          await poll(() =>
            stream.rows.some((r) =>
              r.payload?.type === "server.instance.disposed"
            )
          );
          await oc.api("/session/status");
          await poll(async () =>
            (await oc.rows()).filter((r) => r.kind === "init").length > count
          );
          const second = await oc.waitRow((r) => r.kind === "init");
          assertEquals(second.epoch, first.epoch);
          await oc.api("/global/dispose", "POST");
          await poll(() =>
            stream.rows.some((r) =>
              r.directory === "global" && r.payload?.type === "global.disposed"
            )
          );
          await stream.close();
          await oc.stop();
          await oc.start("0.0.0.0");
          await oc.api("/session/status");
          const third = await oc.waitRow((r) =>
            r.kind === "init" && r.epoch !== first.epoch
          );
          assertEquals(third.serverUrl, oc.serverUrl);
          await proof("C24", {
            loopbackUrl: first.serverUrl,
            wildcardUrl: third.serverUrl,
            before: first.epoch,
            afterDispose: second.epoch,
            afterRestart: third.epoch,
            events: stream.rows.filter((r) =>
              r.payload?.type.includes("disposed")
            ),
          });
        } finally {
          await stream.close();
        }
      },
    );

    await step(
      "C26 Deno and plugin runtime disk-backed temp roots",
      async () => {
        const tmp = Deno.env.get("TMPDIR")!;
        const denoTemp = await Deno.makeTempDir({ prefix: "j0-C26-" });
        assert(denoTemp.startsWith(`${tmp}/`));
        const init = await oc.waitRow((r) => r.kind === "init");
        assertEquals(init.tmpdir, tmp);
        assert((await Deno.stat(`${tmp}/opencode`)).isDirectory);
        await proof("C26", {
          configuredTMPDIR: tmp,
          pluginTmpdir: init.tmpdir,
          denoTemp,
          opencodeTempRootExists: true,
        });
      },
    );

    await step("C6 experimental code-mode child raw hook", async () => {
      await oc.stop();
      await oc.configure({
        mcp: {
          fixture: {
            type: "remote",
            url: "{env:DCMCP_TEST_MCP_URL}",
            oauth: false,
            headers: { Authorization: "Bearer {env:DCMCP_TEST_MCP_TOKEN}" },
            enabled: true,
          },
        },
      });
      await oc.start("127.0.0.1", { OPENCODE_EXPERIMENTAL_CODE_MODE: "1" });
      const result = await turn("code-mode", {
        name: "execute",
        args: {
          code:
            'return await tools.fixture.send_message({text:"C6-code-mode"})',
        },
      });
      const rows = (await oc.rows()).filter((r) =>
        r.kind === "after" &&
        (r.call as Record<string, unknown>)?.sessionID === result.session
      );
      const child = rows.find((r) =>
        (r.call as Record<string, unknown>)?.tool === "fixture_send_message"
      );
      const called = mcp.calls.some((call) => call.text === "C6-code-mode");
      assert(called, "Code-mode must actually invoke the real MCP fixture");
      await proof("C6", {
        sessionID: result.session,
        mcpInvoked: called,
        hook: child ?? null,
        toolParts: result.rows.flatMap((m) => m.parts).filter((p) =>
          p.type === "tool"
        ),
      }, true);
    });

    await step("C19 forced auto-compaction synthetic-user branch", async () => {
      await oc.stop();
      await oc.configure({
        ...provider.config(256),
        compaction: {
          auto: true,
          reserved: 0,
          tail_turns: 0,
          preserve_recent_tokens: 0,
        },
      });
      await oc.start();
      const session = await oc.session("compaction");
      const before = provider.requests.length;
      provider.queue.push(
        { text: "C19-overflow", usage: 300 },
        { text: "C19-summary", usage: 5 },
        { text: "C19-resumed", usage: 5 },
        { text: "C19-summary-extra", usage: 5 },
        { text: "C19-resumed-extra", usage: 5 },
      );
      await oc.prompt(session.id, payload("C19-force-overflow"));
      await oc.final(session.id);
      // A subsequent turn forces the loop to reconsider the previous token usage.
      const second = nativeIDs();
      await oc.prompt(
        session.id,
        payload("C19-trigger-auto-compaction", second),
      );
      await oc.final(session.id);
      const rows = await oc.messages(session.id);
      const compactions = rows.filter((m) =>
        m.parts.some((p) => p.type === "compaction")
      );
      assert(
        compactions.length > 0,
        "Must actually trigger compaction, not merely configure it",
      );
      const users = rows.filter((m) => m.info.role === "user").map((m) => ({
        messageID: m.info.id,
        parts: m.parts.map((p) => ({
          partID: p.id,
          type: p.type,
          synthetic: p.synthetic ?? false,
        })),
        allSynthetic: m.parts.length > 0 && m.parts.every((p) => p.synthetic),
      }));
      provider.queue.splice(0);
      await proof("C19", {
        sessionID: session.id,
        compactionMessages: compactions.map((m) => m.info.id),
        userParts: users,
        providerDelta: provider.requests.length - before,
      }, true);
    });

    assertEquals(provider.unexpected, []);
    await proof("SUMMARY", {
      providerRequests: provider.requests.length,
      mcpCalls: mcp.calls.length,
      unexpectedProviderRequests: provider.unexpected,
      state: oc.root,
    });
  } finally {
    for (const release of releases) release();
    await oc.close();
    await delay.close();
    await mcp.close();
    await provider.close();
    console.log(
      JSON.stringify({
        preservedState: oc.root,
        providerRequests: provider.requests.length,
        unexpectedProviderRequests: provider.unexpected,
      }),
    );
  }
});
