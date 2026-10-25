// SPDX-License-Identifier: LGPL-3.0-only
import { pathfinder } from "@pathfinder/pathfinder";
import { join } from "@std/path";
import type { Config } from "./config.ts";
import { CoreProcess } from "./core/process.ts";
import { publishCoreEvent } from "./core/client.ts";
import { ChangeHub } from "./events.ts";
import { createLog, type Log } from "./log.ts";
import { AccountService } from "./messaging/account.ts";
import { ChatsService } from "./messaging/chats.ts";
import { ContactsService } from "./messaging/contacts.ts";
import { RoomsService } from "./messaging/rooms.ts";
import { SendService } from "./messaging/send.ts";
import { DeleteService } from "./messaging/delete.ts";
import { openStateDb } from "./state/db.ts";
import { serveHttp } from "./http/lifetime.ts";
import { AuthState } from "./auth/state.ts";
import { ApiKeys } from "./auth/api-keys.ts";
import { McpSessions } from "./mcp/sessions.ts";

export interface ServiceBag {
  mcp?: Pick<McpSessions, "handleRequest">;
  auth: AuthState;
  apiKeys: ApiKeys;
  account: AccountService;
  contacts: ContactsService;
  rooms: RoomsService;
  chats: ChatsService;
  send: SendService;
  delete: DeleteService;
  events: ChangeHub;
  log: Log;
  cfg: Omit<Config, "auth">;
  health(): { ok: boolean; core: "ready" | "restarting"; configured: boolean };
}
declare module "@pathfinder/pathfinder" {
  interface App extends ServiceBag {}
}

/** Reserve listener first; one owner joins rollback and every shutdown path. */
export async function startService(
  cfg: Config,
  options: { log?: Log; signals?: boolean; secretPinned?: boolean } = {},
) {
  const log = options.log ??
    createLog(cfg.log.level, [
      cfg.auth.password,
      cfg.auth.totpkey,
      cfg.auth.secretkey,
    ]);
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let closing = false, ready = false, shutdown: Promise<void> | undefined;
  let core: CoreProcess | undefined;
  let chats: ChatsService | undefined;
  let db: ReturnType<typeof openStateDb> | undefined;
  let mcp: McpSessions | undefined;
  const http = serveHttp(cfg.listen, (request) => {
    if (closing || !handler) {
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }
    return handler(request);
  });
  const signals: Deno.Signal[] = [];
  const onSignal = () => {
    closing = true;
    if (ready) {
      void close().catch(() => {
        Deno.exitCode = 1;
      });
    }
  };
  function close(): Promise<void> {
    closing = true;
    if (!shutdown) {
      shutdown = (async () => {
        await mcp?.close();
        chats?.close();
        const results = await Promise.allSettled([
          http.close(),
          core?.close(),
        ]);
        db?.close();
        for (const signal of signals) {
          Deno.removeSignalListener(signal, onSignal);
        }
        const failures = results.filter((result) =>
          result.status === "rejected"
        );
        log.event(failures.length ? "error" : "info", "service_stopped", {
          failures: failures.length,
        });
        if (failures.length) {
          throw new Error("Service shutdown failed");
        }
      })();
    }
    return shutdown;
  }
  try {
    if (options.signals) {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        Deno.addSignalListener(signal, onSignal);
        signals.push(signal);
      }
    }
    await Deno.mkdir(cfg.data.dir, { recursive: true, mode: 0o700 });
    await Deno.chmod(cfg.data.dir, 0o700);
    db = openStateDb(cfg.data.dir);
    const auth = await AuthState.open(cfg, {
      log,
      secretPinned: options.secretPinned,
      qr: (text) => {
        if (!core) throw new Error("Core unavailable");
        return core.use((rpc) => rpc.createQrSvg(text));
      },
    });
    const apiKeys = new ApiKeys(
      db,
      Date.now,
      (values) => log.registerSecrets(values),
    );
    const events = new ChangeHub(() => log.event("warn", "listener_failed"));
    core = new CoreProcess({
      accountsDir: join(cfg.data.dir, "accounts"),
      onEvent: (_account, event) => publishCoreEvent(events, event),
      onState: (state) => {
        events.emit({ type: "connectivity" });
        log.event("info", "core_state", { state });
      },
      onDiagnostic: (kind, fields) => log.event("debug", kind, fields),
    });
    await core.start();
    const account = new AccountService(core, events);
    await account.status();
    chats = new ChatsService(core, account, events, cfg.mcp.waitMaxSeconds);
    mcp = new McpSessions(apiKeys);
    const app: ServiceBag = {
      auth,
      apiKeys,
      mcp,
      account,
      contacts: new ContactsService(core, account),
      rooms: new RoomsService(core, account),
      chats,
      send: new SendService(core, account),
      delete: new DeleteService(core, account),
      events,
      log,
      cfg: {
        listen: { ...cfg.listen },
        data: { ...cfg.data },
        mcp: { ...cfg.mcp },
        log: { ...cfg.log },
      },
      health: () => ({
        ok: true,
        core: core!.state === "ready" ? "ready" : "restarting",
        configured: account.configured,
      }),
    };
    handler = await pathfinder({
      roots: [new URL("./http/routes/", import.meta.url)],
      app,
    });
    ready = true;
    if (closing) await close();
    else {log.event("info", "service_ready", {
        hostname: http.addr.hostname,
        port: http.addr.port,
      });}
    return {
      app,
      addr: http.addr,
      corePid: () => core?.pid,
      close,
      finished: http.finished.then(() => close()),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
