// SPDX-License-Identifier: LGPL-3.0-only
import { extname, join, resolve } from "@std/path";
import { Artifact, type Instance, start } from "./adapter.ts";
import {
  argument,
  deadline,
  files,
  poll,
  record,
  requireThat,
  sha256,
  workspace,
} from "./common.ts";
import { api, connect, tool } from "./protocol.ts";

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
async function assets(instance: Instance, root: string) {
  const manifest: { path: string; sha256: string; mime: string }[] = [];
  for (const path of await files(root)) {
    const response = await api(instance.url, `/${path}`);
    const expected = await sha256(await Deno.readFile(join(root, path)));
    const actual = await sha256(new Uint8Array(await response.arrayBuffer()));
    requireThat(
      actual === expected,
      `Asset bytes differ: ${path}, expected ${expected}, got ${actual}`,
    );
    requireThat(
      response.headers.get("content-type")?.startsWith(mime[extname(path)]),
      `Asset MIME: ${path}`,
    );
    manifest.push({ path, sha256: actual, mime: mime[extname(path)] });
  }
  requireThat(
    manifest.some((f) => f.path.endsWith(".js")) &&
      manifest.some((f) => f.path.endsWith(".woff2")),
    "Incomplete web distribution",
  );
  const deep = await api(instance.url, "/chats/987654");
  requireThat(
    await sha256(new Uint8Array(await deep.arrayBuffer())) ===
      await sha256(await Deno.readFile(join(root, "index.html"))),
    "Deep SPA navigation",
  );
  await (await api(instance.url, "/api/nonexistent", { status: 404 })).body
    ?.cancel();
  return manifest;
}
async function mcp(instance: Instance, key?: string) {
  const client = await connect(instance.url, key);
  try {
    const tools = await client.listTools();
    requireThat(tools.tools.length === 17, "Missing reflective MCP tools");
    const status = await tool<{ configured: boolean }>(client, "status");
    requireThat(status.configured === false, "Fixture unexpectedly configured");
    return { initialized: true, tools: tools.tools.length, configured: false };
  } finally {
    await client.close();
  }
}
async function healthy(instance: Instance) {
  const response = await api(instance.url, "/_/health");
  requireThat(
    JSON.stringify(await response.json()) ===
      JSON.stringify({ ok: true, core: "ready", configured: false }),
    "Health contract",
  );
}
async function heldShutdown(instance: Instance, incomplete: boolean) {
  let connection: Deno.TcpConn | undefined;
  let reading: Promise<string> | undefined;
  if (incomplete) {
    const u = new URL(instance.url);
    connection = await Deno.connect({
      hostname: u.hostname,
      port: Number(u.port),
    });
    const received: string[] = [];
    reading = (async () => {
      for await (
        const chunk of connection!.readable.pipeThrough(new TextDecoderStream())
      ) received.push(chunk);
      return received.join("");
    })();
    await connection.write(
      new TextEncoder().encode(
        `GET /_/health HTTP/1.1\r\nHost: ${u.host}\r\nContent-Length: 53\r\nConnection: close\r\n\r\n{`,
      ),
    );
    // A response proves admission, not merely an open TCP socket.
    await poll(() => received.join("").includes('"core":"ready"'));
  }
  try {
    const result = await instance.stop();
    if (reading) await deadline(reading, 1000);
    return { ...result, admittedIncompleteRequest: incomplete };
  } finally {
    try {
      connection?.close();
    } catch { /* reader already closed it */ }
  }
}
export async function smoke(
  artifact: Artifact,
  root: string,
  assetRoot: string,
) {
  workspace(root);
  await Deno.mkdir(root, { mode: 0o700 }); // Never overwrite a previous run.
  const outcomes: Record<string, unknown> = {};
  const fixtures = {
    public: join(root, "public"),
    protected: join(root, "protected"),
    invalid: join(root, "invalid"),
    collision: join(root, "collision"),
    precedence: join(root, "precedence"),
  };
  let active: Instance | undefined;
  try {
    active = await start(artifact, fixtures.public);
    await healthy(active);
    outcomes.coldExtraction = {
      core: active.core,
      executable: active.extraction,
    };
    outcomes.assets = await assets(active, assetRoot);
    await (await api(active.url, "/api/auth/setup", {
      method: "POST",
      body: { type: "public" },
    })).body?.cancel();
    const relays = await (await api(active.url, "/api/relays")).json();
    requireThat(relays && typeof relays === "object", "Bundled relay route");
    outcomes.publicMcp = await mcp(active);
    outcomes.publicShutdown = await heldShutdown(active, false);
    active = undefined;
    record("public-bootstrap-assets-mcp-shutdown", {
      assets: (outcomes.assets as unknown[]).length,
    });

    active = await start(artifact, fixtures.protected);
    const noKey = await fetch(`${active.url}/mcp`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    requireThat(noKey.status === 503, "Unconfigured access must reject MCP");
    await noKey.body?.cancel();
    const password = crypto.randomUUID();
    const setup = await api(active.url, "/api/auth/setup", {
      method: "POST",
      body: { type: "password", username: "fixture", password },
    });
    const cookie = setup.headers.get("set-cookie")?.split(";")[0];
    requireThat(cookie, "Setup cookie absent");
    await setup.body?.cancel();
    const rejected = await fetch(`${active.url}/mcp`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    requireThat(
      rejected.status === 401 &&
        rejected.headers.get("www-authenticate") === "Bearer",
      "Anonymous MCP must reject",
    );
    await rejected.body?.cancel();
    await (await api(active.url, "/api/keys", { status: 401 })).body?.cancel();
    const created = await (await api(active.url, "/api/keys", {
      method: "POST",
      cookie,
      body: { name: "packaging fixture" },
      status: 201,
    })).json();
    requireThat(typeof created.key === "string", "API key missing");
    outcomes.protectedMcp = await mcp(active, created.key);
    outcomes.normalShutdown = await heldShutdown(active, false);
    active = undefined;
    active = await start(artifact, fixtures.protected);
    const listed = await (await api(active.url, "/api/keys", { cookie }))
      .json();
    requireThat(
      JSON.stringify(listed).includes(created.id),
      "Cookie/key persistence",
    );
    const login = await api(active.url, "/api/auth/login", {
      method: "POST",
      body: { username: "fixture", password },
    });
    requireThat(login.headers.has("set-cookie"), "Persisted password login");
    await login.body?.cancel();
    outcomes.restartedMcp = await mcp(active, created.key);
    outcomes.incompleteShutdown = await heldShutdown(active, true);
    active = undefined;
    record("password-cookie-key-persistence-incomplete-shutdown");

    await Deno.mkdir(fixtures.precedence, { mode: 0o700 });
    const overlay = join(fixtures.precedence, "overlay.toml");
    await Deno.writeTextFile(
      overlay,
      '[listen]\nport = 1\n[auth]\ntype = "password"\nusername = "overlay"\npassword = "fixture-only-overlay"\n',
    );
    active = await start(artifact, fixtures.precedence, {
      DCMCP_CONFIG: artifact.kind === "image" ? "/data/overlay.toml" : overlay,
      DCMCP_AUTH_TYPE: "public",
    });
    await healthy(active);
    outcomes.precedence = await mcp(active);
    await active.stop();
    active = undefined;
    const invalid = await artifact.start(fixtures.invalid, {
      DCMCP_LISTEN_PORT: "invalid",
    }, true);
    requireThat(
      "failed" in invalid && invalid.failed,
      "Invalid config accepted",
    );
    outcomes.invalidConfig = invalid;
    if (artifact.kind === "binary") {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      try {
        const failed = await artifact.start(fixtures.collision, {
          DCMCP_LISTEN_PORT: String(listener.addr.port),
        }, true);
        requireThat(
          "failed" in failed && failed.failed,
          "Listener collision accepted",
        );
        let absent = false;
        try {
          await Deno.stat(join(fixtures.collision, "state"));
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) absent = true;
          else throw e;
        }
        requireThat(absent, "Collision wrote durable state");
        outcomes.listenerCollision = failed;
      } finally {
        listener.close();
      }
    }
    outcomes.identity = artifact.kind === "binary"
      ? {
        binary: artifact.target,
        sha256: await sha256(await Deno.readFile(artifact.target)),
      }
      : { image: artifact.target };
    const result = {
      passed: true,
      target: artifact.kind,
      outcomes,
      ownedChildrenAbsent: true,
    };
    await Deno.writeTextFile(
      join(root, "result.json"),
      JSON.stringify(result, null, 2),
    );
    record("packaged-artifact-smoke-passed", {
      target: artifact.kind,
      ownedChildrenAbsent: true,
    });
    return result;
  } catch (error) {
    await Deno.writeTextFile(
      join(root, "failure.json"),
      JSON.stringify(
        { passed: false, error: String(error), outcomes },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (active) await active.stop();
  }
}
if (import.meta.main) {
  const kind = Deno.args.includes("--binary") ? "binary" : "image";
  await smoke(
    new Artifact(
      kind,
      kind === "binary" ? resolve(argument("--binary")) : argument("--image"),
    ),
    workspace(argument("--workspace")),
    resolve(argument("--assets")),
  );
}
