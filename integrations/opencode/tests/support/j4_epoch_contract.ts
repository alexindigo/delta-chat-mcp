// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { ProviderFixture } from "./provider_fixture.ts";
import { McpFixture } from "./mcp_fixture.ts";
import { DelayControl, OpenCodeProcess } from "./opencode_process.ts";

export async function epochContract() {
  const provider = new ProviderFixture(),
    mcp = new McpFixture(),
    delay = new DelayControl();
  const oc = await OpenCodeProcess.create(provider, mcp, delay.url);
  const log = `${oc.root}/epochs.jsonl`;
  try {
    const artifacts = [];
    const hashes = [];
    for (const name of ["artifact-a.js", "artifact-b.js"]) {
      const path = `${oc.root}/${name}`;
      await Deno.copyFile(
        new URL("../../dist/delta-chat-mcp-opencode.js", import.meta.url),
        path,
      );
      artifacts.push(new URL(`file://${path}`).href);
      hashes.push(
        [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", await Deno.readFile(path)),
          ),
        ].map((n) => n.toString(16).padStart(2, "0")).join(""),
      );
    }
    assertEquals(hashes[0], hashes[1]);
    await oc.configure({
      plugin: [[
        new URL("../fixtures/epoch-probe-plugin.ts", import.meta.url).href,
        {
          artifacts,
          log,
          stateFile: `${oc.root}/epoch-state/wake.sqlite`,
        },
      ]],
    });
    const rows = async () =>
      (await Deno.readTextFile(log)).trim().split("\n").map((s) =>
        JSON.parse(s) as {
          index: number;
          epoch: string;
          nonreplaceable: boolean;
        }
      );
    await oc.start();
    await oc.api("/session/status");
    const first = await rows();
    assertEquals(first.length, 2);
    console.log(
      JSON.stringify({
        contract: "C24b-first",
        version: await oc.version(),
        artifacts,
        hashes,
        epochs: first,
        state: oc.root,
      }),
    );
    assert(first.every((row) => row.nonreplaceable));
    assertEquals(
      first[0].epoch,
      first[1].epoch,
      "C24b: distinct artifact URLs must share one process capability",
    );
    await oc.api("/instance/dispose", "POST");
    await oc.api("/session/status");
    const disposed = await rows();
    assertEquals(disposed.length, 4);
    assert(disposed.every((row) => row.epoch === first[0].epoch));
    await oc.stop();
    await oc.start();
    await oc.api("/session/status");
    const restarted = await rows();
    assertEquals(restarted.length, 6);
    assertEquals(restarted[4].epoch, restarted[5].epoch);
    assert(restarted[4].epoch !== first[0].epoch);
    assertEquals(provider.requests.length, 0);
    console.log(
      JSON.stringify({
        contract: "C24b",
        version: await oc.version(),
        result: "PASS",
        hashes,
        first,
        disposed: disposed.slice(2),
        restarted: restarted.slice(4),
        state: oc.root,
      }),
    );
  } finally {
    await oc.close();
    await delay.close();
    await mcp.close();
    await provider.close();
  }
}
