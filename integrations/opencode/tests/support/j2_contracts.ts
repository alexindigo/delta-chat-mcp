// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { deadline } from "../../../../tests/support.ts";
import { ProviderFixture } from "./provider_fixture.ts";
import { McpFixture } from "./mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./opencode_process.ts";

export async function runJ2Contracts() {
  const provider = new ProviderFixture();
  const mcp = new McpFixture();
  const delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  const state = `${oc.root}/j2-state/wake.sqlite`;
  const options = {
    relays: {
      fixture: {
        url: "{env:DCMCP_TEST_MCP_URL}",
        headers: { Authorization: "Bearer {env:DCMCP_TEST_MCP_TOKEN}" },
        // This foundation-only probe never consumes the relay inbox.
        enabled: false,
      },
    },
    stateFile: state,
  };
  const bundle =
    new URL("../../dist/delta-chat-mcp-opencode.js", import.meta.url).href;
  const probe =
    new URL("../fixtures/bundle-probe-plugin.ts", import.meta.url).href;
  try {
    await oc.configure({ plugin: [[bundle, options], [probe, options]] });
    const version = await oc.version();
    await oc.start();
    const session = await oc.session("J2 actual bundle");
    provider.queue.push({
      tool: { name: "j2_foundation", args: { action: "write" } },
    }, { text: "J2 bundle answer" });
    const messageID = `msg_j2${crypto.randomUUID().replaceAll("-", "")}`;
    await oc.prompt(session.id, {
      messageID,
      agent: "selected",
      model: { providerID: "test", modelID: "test-model" },
      variant: "careful",
      parts: [{
        id: `prt_j2${crypto.randomUUID().replaceAll("-", "")}`,
        type: "text",
        text: "exercise foundation",
      }],
    });
    await oc.final(session.id, messageID);
    const rows = await oc.messages(session.id);
    const tool = rows.flatMap((m) => m.parts).find((p) =>
      p.tool === "j2_foundation"
    );
    assertEquals(tool?.state?.status, "completed");
    const facts = JSON.parse(tool!.state!.output!);
    assertEquals(facts.sessionID, session.id);
    assertEquals(facts.runtime, "bun:sqlite");
    assertEquals(facts.owner, oc.serverUrl);
    assertEquals(facts.directories, [oc.directory]);
    assertEquals(facts.resolvedUrl, true);
    assertEquals(facts.resolvedHeader, true);
    assertEquals(facts.selection, {
      agent: "selected",
      model: { providerID: "test", modelID: "test-model" },
      variant: "careful",
    });
    assert(JSON.stringify(provider.requests.at(-1)).includes(session.id));
    const probeAgain = async () => {
      provider.queue.push({
        tool: { name: "j2_foundation", args: { action: "write" } },
      }, { text: "J2 epoch answer" });
      const id = `msg_j2${crypto.randomUUID().replaceAll("-", "")}`;
      await oc.prompt(session.id, {
        messageID: id,
        agent: "selected",
        model: { providerID: "test", modelID: "test-model" },
        variant: "careful",
        parts: [{
          id: `prt_j2${crypto.randomUUID().replaceAll("-", "")}`,
          type: "text",
          text: "exercise epoch",
        }],
      });
      await oc.final(session.id, id);
      const part = (await oc.messages(session.id)).flatMap((row) => row.parts)
        .findLast((p) => p.tool === "j2_foundation");
      assertEquals(part?.state?.status, "completed");
      return JSON.parse(part!.state!.output!);
    };
    const read = async (writePermission: boolean) => {
      const result = await deadline(
        new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--no-config",
            "--no-remote",
            `--allow-read=${oc.root}/j2-state`,
            ...(writePermission ? [`--allow-write=${oc.root}/j2-state`] : []),
            new URL("../fixtures/registry-reader.ts", import.meta.url).pathname,
            state,
            oc.serverUrl,
          ],
          env: { TMPDIR: Deno.env.get("TMPDIR")! },
          stdout: "piped",
          stderr: "piped",
        }).output(),
        15_000,
      );
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    };
    const minimal = await read(false);
    // A3 explicitly permits state-directory write only if WAL requires it.
    let permissions = "--allow-read=<state dir>";
    let alive = minimal;
    if (minimal.code !== 0) {
      assert(minimal.stderr.includes("write access"), minimal.stderr);
      alive = await read(true);
      permissions += " --allow-write=<state dir>";
    }
    assertEquals(alive.code, 0, alive.stderr);
    const aliveFacts = JSON.parse(alive.stdout);
    assertEquals(aliveFacts.directories, [oc.directory]);
    assertEquals(aliveFacts.writeRejected, true);
    await oc.api("/instance/dispose", "POST");
    const afterDispose = await probeAgain();
    assertEquals(afterDispose.epoch, facts.epoch);
    await oc.stop("SIGKILL");
    const killed = await read(permissions.includes("--allow-write"));
    assertEquals(killed.code, 0, killed.stderr);
    assertEquals(JSON.parse(killed.stdout), aliveFacts);
    await oc.start();
    const afterRestart = await probeAgain();
    assert(afterRestart.epoch !== facts.epoch);
    assertEquals(provider.requests.length, 6);
    // Close both actual-bundle registry owners before a clean server stop.
    // K1c's absent companions distinguish this from the SIGKILL/WAL proof.
    await oc.api("/global/dispose", "POST");
    await oc.stop();
    const absent = async (path: string) => {
      try {
        await Deno.stat(path);
        return false;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return true;
        throw error;
      }
    };
    assert(
      await absent(`${state}-wal`),
      "K1c requires absent WAL after clean close",
    );
    assert(
      await absent(`${state}-shm`),
      "K1c requires absent SHM after clean close",
    );
    const clean = await read(false);
    assertEquals(
      clean.code,
      0,
      "K1c minimal reader failed; stop, do not widen permissions: " +
        clean.stderr,
    );
    assertEquals(JSON.parse(clean.stdout), aliveFacts);
    const proof = {
      time: new Date().toISOString(),
      version,
      contract: "C2-realbundle/K1/A-J2-5",
      result: "PASS",
      bundle,
      state: oc.root,
      ...facts,
      permissions,
      readOnlyBranch: aliveFacts.branch,
      aliveDirectories: aliveFacts.directories,
      afterKillDirectories: JSON.parse(killed.stdout).directories,
      writeRejected: true,
      providerRequests: provider.requests.length,
      afterDisposeEpoch: afterDispose.epoch,
      afterRestartEpoch: afterRestart.epoch,
      K1c: {
        cleanStop: true,
        absentWal: true,
        absentShm: true,
        minimalReadOnly: true,
        writeRejected: true,
        directories: JSON.parse(clean.stdout).directories,
      },
    };
    await Deno.writeTextFile(
      `${oc.root}/j2-contracts.jsonl`,
      JSON.stringify(proof) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify(proof));
    assertEquals(provider.unexpected, []);
  } finally {
    await oc.close();
    await delay.close();
    await mcp.close();
    await provider.close();
  }
}
