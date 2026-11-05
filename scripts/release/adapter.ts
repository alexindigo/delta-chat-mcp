// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { command, deadline, poll, requireThat, withOwners } from "./common.ts";

export interface Instance {
  url: string;
  core: number;
  extraction: string;
  stop(): Promise<{ exitCode: number; elapsedMs: number; coreAbsent: boolean }>;
}
export class Artifact {
  private sequence = 0;
  constructor(readonly kind: "binary" | "image", readonly target: string) {}

  async start(root: string, env: Record<string, string> = {}, fail = false) {
    const run = join(root, `run-${++this.sequence}`);
    await Deno.mkdir(run, { recursive: true, mode: 0o700 });
    for (const dir of ["cwd", "home", "cache", "tmp", "empty-path"]) {
      await Deno.mkdir(join(run, dir), { mode: 0o700 });
    }
    if (this.kind === "image") return await this.image(root, run, env, fail);
    return await this.binary(root, run, env, fail);
  }

  private async binary(
    root: string,
    run: string,
    env: Record<string, string>,
    fail: boolean,
  ) {
    const child = new Deno.Command(this.target, {
      cwd: join(run, "cwd"),
      clearEnv: true,
      env: {
        HOME: join(run, "home"),
        XDG_DATA_HOME: join(run, "cache"),
        TMPDIR: join(run, "tmp"),
        DENO_DIR: join(run, "cache", "deno"),
        PATH: join(run, "empty-path"),
        DCMCP_DATA_DIR: join(root, "state"),
        DCMCP_LISTEN_HOSTNAME: "127.0.0.1",
        DCMCP_LISTEN_PORT: "0",
        ...env,
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const log: string[] = [];
    let port: number | undefined;
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const bytes of stream) {
        const chunk = decoder.decode(bytes, { stream: true });
        log.push(chunk);
        pending += chunk;
        while (pending.includes("\n")) {
          const i = pending.indexOf("\n"), line = pending.slice(0, i);
          pending = pending.slice(i + 1);
          try {
            const value = JSON.parse(line);
            if (value.event === "service_ready") port = value.fields.port;
          } catch { /* native diagnostic line */ }
        }
      }
    };
    const output = Promise.all([pump(child.stdout), pump(child.stderr)]);
    let exited = false;
    const status = child.status.then((value) => {
      exited = true;
      return value;
    });
    // Bounded even if the caller fails before it can acquire an Instance.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch { /* joined */ }
    }, 720000);
    const save = async () => {
      await output;
      await Deno.writeTextFile(join(run, "service.log"), log.join(""), {
        mode: 0o600,
      });
    };
    const stop = async () => {
      const start = Date.now();
      if (!exited) child.kill("SIGTERM");
      const result = await deadline(status, 15000);
      clearTimeout(timer);
      await save();
      requireThat(
        result.code === 0,
        `Service exit ${result.code}; see ${run}/service.log`,
      );
      return {
        exitCode: result.code,
        elapsedMs: Date.now() - start,
        coreAbsent: true,
      };
    };
    try {
      if (fail) {
        const result = await deadline(status, 15000);
        requireThat(
          result.code !== 0,
          "Invalid startup unexpectedly succeeded",
        );
        await save();
        clearTimeout(timer);
        const children = await this.children(child.pid);
        requireThat(children.length === 0, "Failed startup leaked a child");
        return { failed: true, exitCode: result.code };
      }
      await poll(() => {
        requireThat(!exited, `Service exited; ${log.join("")}`);
        return !!port;
      }, 30000);
      const children = await this.children(child.pid);
      requireThat(
        children.length === 1,
        "Expected exactly one native core child",
      );
      const core = children[0];
      const extraction = await Deno.readLink(`/proc/${core}/exe`);
      requireThat(
        extraction.endsWith("deltachat-rpc-server"),
        "Wrong native core executable",
      );
      requireThat(
        (await Deno.stat(extraction)).mode! & 0o111,
        "Native core not executable",
      );
      return {
        url: `http://127.0.0.1:${port}`,
        core,
        extraction,
        stop: async () => {
          const result = await stop();
          await poll(() => !this.alive(core));
          requireThat(
            (await this.children(child.pid)).length === 0,
            "Native child leaked",
          );
          requireThat(
            !log.join("").includes("Download"),
            "Runtime dependency download",
          );
          return result;
        },
      };
    } catch (error) {
      clearTimeout(timer);
      if (!exited) {
        child.kill("SIGTERM");
        try {
          await deadline(status, 15000);
        } catch {
          child.kill("SIGKILL");
          await status;
        }
      }
      await save();
      throw error;
    }
  }

  private alive(pid: number) {
    try {
      Deno.kill(pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }
  private async children(pid: number) {
    try {
      const ids = (await Deno.readTextFile(`/proc/${pid}/task/${pid}/children`))
        .trim();
      return ids ? ids.split(/\s+/).map(Number) : [];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }

  private async image(
    root: string,
    run: string,
    env: Record<string, string>,
    fail: boolean,
  ) {
    requireThat(
      Deno.env.get("RUNNER_ENVIRONMENT") === "github-hosted",
      "Docker only in GitHub VM",
    );
    const name = `dcmcp-smoke-${crypto.randomUUID()}`;
    const docker = (args: string[]) => command("docker", args, { ms: 30000 });
    const volumeFile = join(root, "volume.txt");
    let volume: string;
    try {
      volume = (await Deno.readTextFile(volumeFile)).trim();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      volume = `dcmcp-proof-${crypto.randomUUID()}`;
      await docker([
        "volume",
        "create",
        "--label",
        "delta-chat-mcp=release-proof",
        volume,
      ]);
      await Deno.writeTextFile(volumeFile, volume);
    }
    requireThat(
      /^dcmcp-proof-[0-9a-f-]+$/.test(volume),
      "Unexpected fixture volume",
    );
    const args = [
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      "delta-chat-mcp=release-proof",
      "--publish",
      "127.0.0.1::8080",
      "--mount",
      `type=volume,src=${volume},dst=/data`,
    ];
    const settings: Record<string, string> = {
      DCMCP_LISTEN_PORT: "8080",
      ...env,
    };
    if (settings.DCMCP_CONFIG) {
      args.push(
        "--mount",
        `type=bind,src=${root}/overlay.toml,dst=/config.toml,readonly`,
      );
      settings.DCMCP_CONFIG = "/config.toml";
    }
    for (const [key, value] of Object.entries(settings)) {
      args.push("--env", `${key}=${value}`);
    }
    await docker([...args, this.target]);
    const save = async () => {
      const text = await command("docker", ["logs", name], {
        ms: 30000,
        combined: true,
      });
      await Deno.writeTextFile(join(run, "service.log"), text, { mode: 0o600 });
    };
    try {
      if (fail) {
        const code = Number(await docker(["wait", name]));
        requireThat(code !== 0, "Invalid image startup succeeded");
        await save();
        await docker(["rm", name]);
        return { failed: true, exitCode: code };
      }
      const port = (await docker(["port", name, "8080/tcp"])).split(":").at(-1);
      const url = `http://127.0.0.1:${port}`;
      await poll(async () => {
        try {
          const response = await fetch(`${url}/_/health`, {
            signal: AbortSignal.timeout(1000),
          });
          const ok = response.ok;
          await response.body?.cancel();
          return ok;
        } catch {
          return false;
        }
      }, 30000);
      const inspect = JSON.parse(await docker(["inspect", name]))[0];
      requireThat(
        inspect.Config.User === "1000:1000",
        "Image must declare UID/GID 1000",
      );
      const facts = await docker([
        "exec",
        name,
        "sh",
        "-ec",
        'test "$(id -u)" = 1000; ! command -v deno; ! command -v node; test ! -d /app/src; test ! -w /app; cat /proc/1/task/1/children',
      ]);
      const children = facts.trim().split(/\s+/).map(Number);
      requireThat(
        children.length === 1 && Number.isInteger(children[0]),
        "Image native child count",
      );
      const core = children[0];
      const extraction = await docker([
        "exec",
        name,
        "readlink",
        `/proc/${core}/exe`,
      ]);
      requireThat(
        extraction.startsWith("/data/cache/"),
        "Image extraction must use private XDG fallback",
      );
      requireThat(
        extraction.endsWith("deltachat-rpc-server"),
        "Image native executable",
      );
      return {
        url,
        core,
        extraction,
        stop: async () => {
          const start = Date.now();
          await docker(["kill", "--signal=TERM", name]);
          const code = Number(await docker(["wait", name]));
          const state = JSON.parse(await docker(["inspect", name]))[0].State;
          await save();
          const elapsedMs = Date.now() - start;
          requireThat(
            code === 0 && elapsedMs < 15000 && !state.Running &&
              state.Pid === 0,
            "Image joined shutdown failed",
          );
          await docker(["rm", name]);
          return { exitCode: code, elapsedMs, coreAbsent: true };
        },
      };
    } catch (error) {
      return await withOwners((own) => {
        own(save);
        own(() => docker(["stop", "--time", "15", name]));
        return Promise.reject(error);
      });
    }
  }
}

export async function start(
  artifact: Artifact,
  root: string,
  env: Record<string, string> = {},
) {
  const result = await artifact.start(root, env);
  requireThat("url" in result, "Expected running artifact");
  return result as Instance;
}
