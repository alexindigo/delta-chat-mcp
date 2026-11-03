// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startService } from "../../../../src/service.ts";
import { loadRuntimeConfig } from "../../../../src/auth/state.ts";
import { createLog } from "../../../../src/log.ts";
import { startTestPeer } from "../../../../src/core/test-peer.ts";
import {
  type CoreEvent,
  createCoreFacade,
} from "../../../../src/core/client.ts";
import { startDeltaChat } from "@deltachat/stdio-rpc-server";
import { once } from "node:events";
import { AccountService } from "../../../../src/messaging/account.ts";
import { ChangeHub } from "../../../../src/events.ts";
import { deadline, fixture, poll } from "../../../../tests/support.ts";
import { decodePlaintextHtml } from "../../../../src/messaging/plaintext-html.ts";

export async function relayWorld(
  options: { gateWaitResponses?: boolean; partialDownloads?: boolean } = {},
) {
  assertEquals(Deno.env.get("CHATMAIL_DOMAIN"), "ci-chatmail.testrun.org");
  const root = await fixture("j3-relay-world");
  const clients: Client[] = [];
  const services: Awaited<ReturnType<typeof startService>>[] = [];
  const proxies: Deno.HttpServer<Deno.NetAddr>[] = [];
  let waits = Promise.withResolvers<void>();
  const readFailure = { enabled: false, rejected: 0 };
  if (!options.gateWaitResponses) waits.resolve();
  let peer: Awaited<ReturnType<typeof startTestPeer>> | undefined;
  const close = async () => {
    waits.resolve();
    await Promise.all(clients.map((c) => c.close()));
    await peer?.close();
    await Promise.all(services.map((s) => s.close()));
    await Promise.all(proxies.map((p) => p.shutdown()));
  };
  try {
    const create = async (name: string) => {
      const config = loadRuntimeConfig({
        DCMCP_DATA_DIR: `${root}/${name}`,
        DCMCP_LISTEN_PORT: "0",
      }).cfg;
      let service = await startService(
        config,
        { log: createLog("error", [], () => {}) },
      );
      services.push(service);
      let origin = `http://127.0.0.1:${service.addr.port}`;
      let mcpUrl = `${origin}/mcp`;
      if (options.gateWaitResponses) {
        const proxy = Deno.serve({
          hostname: "127.0.0.1",
          port: 0,
          onListen() {},
        }, async (request) => {
          const body = request.method === "POST"
            ? await request.clone().json().catch(() => undefined)
            : undefined;
          if (
            readFailure.enabled && (
              body?.method === "tools/call" &&
                body.params?.name === "read_messages" ||
              body?.method === "resources/read" &&
                String(body.params?.uri).includes("/delivery/")
            )
          ) {
            readFailure.rejected++;
            return Response.json({ error: "Service closing" }, { status: 503 });
          }
          const response = await fetch(
            new Request(new URL("/mcp", origin), request),
          );
          if (
            body?.method === "tools/call" &&
            body.params?.name === "wait_for_messages"
          ) {
            try {
              await new Promise<void>((resolve, reject) => {
                const aborted = () => reject(request.signal.reason);
                if (request.signal.aborted) {
                  aborted();
                  return;
                }
                request.signal.addEventListener("abort", aborted, {
                  once: true,
                });
                void waits.promise.then(() => {
                  request.signal.removeEventListener("abort", aborted);
                  resolve();
                });
              });
            } catch {
              await response.body?.cancel();
              return new Response(null, { status: 499 });
            }
          }
          return response;
        });
        proxies.push(proxy);
        mcpUrl = `http://127.0.0.1:${proxy.addr.port}/mcp`;
      }
      const setup = await fetch(`${origin}/api/auth/setup`, {
        method: "POST",
        headers: { Origin: origin, "content-type": "application/json" },
        body: JSON.stringify({
          type: "password",
          username: "test",
          password: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      assertEquals(setup.status, 200);
      const cookie = setup.headers.get("set-cookie")!.split(";")[0];
      await setup.body?.cancel();
      const response = await fetch(`${origin}/api/keys`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "J3 isolated OpenCode" }),
        signal: AbortSignal.timeout(10_000),
      });
      assertEquals(response.status, 201);
      const { key } = await response.json();
      await service.app.account.create({
        relay: "ci-chatmail.testrun.org",
        displayName: `J3 ${name} ${crypto.randomUUID()}`,
      });
      if (options.partialDownloads && name === "first") {
        // Fixture-only core setting, via its real API while the service/core is
        // fully stopped. v2.65.0 config.rs documents download_limit pre-messages.
        await service.close();
        const setupCore = startDeltaChat(`${root}/${name}/accounts`, {
          disableEnvPath: true,
          muteStdErr: true,
        });
        const closed = Promise.all([
          once(setupCore.transport.input, "close"),
          once(setupCore.transport.output, "close"),
        ]);
        try {
          await setupCore.rpc.getSystemInfo();
          const ids = await setupCore.rpc.getAllAccountIds();
          assertEquals(ids.length, 1);
          await setupCore.rpc.setConfig(ids[0], "download_limit", "1");
          assertEquals(
            await setupCore.rpc.getConfig(ids[0], "download_limit"),
            "1",
          );
        } finally {
          setupCore.close();
          await deadline(closed, 10_000);
        }
        service = await startService(
          loadRuntimeConfig({
            DCMCP_DATA_DIR: `${root}/${name}`,
            DCMCP_LISTEN_PORT: "0",
          }).cfg,
          { log: createLog("error", [], () => {}) },
        );
        services.push(service);
        origin = `http://127.0.0.1:${service.addr.port}`;
        if (!options.gateWaitResponses) mcpUrl = `${origin}/mcp`;
      }
      const client = new Client({ name: "j3-world", version: "1" }, {
        versionNegotiation: { mode: "legacy" },
      });
      clients.push(client);
      await deadline(
        client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${key}` } },
          }),
        ),
      );
      return {
        service,
        client,
        config: {
          type: "remote",
          url: mcpUrl,
          oauth: false,
          headers: { Authorization: `Bearer ${key}` },
          enabled: true,
        },
      };
    };
    const first = await create("first"), second = await create("second");
    const tool = async <T>(
      client: Client,
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      const result = await client.callTool({ name, arguments: args }, {
        timeout: 70_000,
      });
      assert(!result.isError, `World tool ${name} failed`);
      assert(result.structuredContent !== undefined);
      return result.structuredContent as T;
    };
    const joined: number[] = [];
    const peerEvent = (event: CoreEvent) => {
      if (
        event.kind === "SecurejoinJoinerProgress" && event.progress === 1000
      ) joined.push(event.contactId);
    };
    peer = await startTestPeer(`${root}/peer`, peerEvent);
    const account = new AccountService(
      { use: (op) => peer!.call(op) },
      new ChangeHub(),
    );
    const status = await account.create({
      relay: "ci-chatmail.testrun.org",
      displayName: "J3 throwaway peer",
    });
    assert(status.accountId !== null);
    const id = status.accountId;
    await peer.call((rpc) => rpc.setConfig(id, "mdns_enabled", "1"));
    const invite = await first.service.app.account.inviteLink();
    const qr = await peer.call((rpc) => rpc.checkQr(id, invite));
    assertEquals(qr.kind, "askVerifyContact");
    if (qr.kind !== "askVerifyContact") {
      throw new Error("Unexpected invitation");
    }
    await peer.call((rpc) => rpc.secureJoin(id, invite));
    await poll(() => joined.includes(qr.contact_id), 60_000);
    let contact = 0;
    await poll(async () => {
      contact = (await first.service.app.contacts.list()).find((c) =>
        c.displayName === "J3 throwaway peer" && c.isKeyContact && c.e2eeAvail
      )?.id ?? 0;
      return contact > 0;
    }, 60_000);
    const room = (await tool<{ chat_id: number }>(first.client, "create_room", {
      name: "J3 shared room",
      contact_ids: [contact],
    })).chat_id;
    let secondRoom =
      (await tool<{ chat_id: number }>(second.client, "create_room", {
        name: "J3 other identity",
        contact_ids: [],
      })).chat_id;
    if (secondRoom !== room) {
      secondRoom =
        (await tool<{ chat_id: number }>(second.client, "create_room", {
          name: "J3 same numeric chat on other identity",
          contact_ids: [],
        })).chat_id;
    }
    // A chat-ID-only key would wrongly collapse these distinct relay identities.
    assertEquals(secondRoom, room);
    const receives = async (text: string) => {
      let found:
        | { id: number; chatId: number; showPadlock: boolean }
        | undefined;
      await poll(async () => {
        const chats = await peer!.call((rpc) =>
          rpc.getChatlistEntries(id, null, null, null)
        );
        for (const chat of chats) {
          const messages = await peer!.call(async (rpc) =>
            rpc.getMessages(id, await rpc.getMessageIds(id, chat, false, false))
          );
          for (const message of Object.values(messages)) {
            if (message?.kind === "message" && message.text === text) {
              found = message;
            }
          }
        }
        return !!found;
      }, 60_000);
      assert(found?.showPadlock);
      return found!;
    };
    // Same established J1 stock-peer path (messaging_test.ts:493–509), confined
    // to this world's existing CI identity; no product/shared facade widening.
    let stock: ReturnType<typeof startDeltaChat> | undefined;
    const rawPeer = async () => {
      if (stock) return stock;
      await peer!.close();
      stock = startDeltaChat(`${root}/peer`, {
        disableEnvPath: true,
        muteStdErr: true,
      });
      const closed = Promise.all([
        once(stock.transport.input, "close"),
        once(stock.transport.output, "close"),
      ]);
      stock.on("ALL", (_account, event) => peerEvent(event));
      const facade = createCoreFacade(stock.rpc);
      let closing: Promise<void> | undefined;
      peer = {
        ...peer!,
        call: (operation) => deadline(operation(facade), 120_000),
        close: () =>
          closing ??= (() => {
            stock!.close();
            return deadline(closed, 10_000).then(() => {});
          })(),
      };
      await stock.rpc.getSystemInfo();
      await stock.rpc.startIo(id);
      return stock;
    };
    const incoming = async (
      roomId: number,
      predicate: (
        m: Awaited<ReturnType<typeof first.service.app.chats.messages>>[number],
      ) => boolean,
    ) => {
      let result:
        | Awaited<ReturnType<typeof first.service.app.chats.messages>>[number]
        | undefined;
      await poll(async () => {
        result =
          (await first.service.app.chats.messages(roomId, { limit: 100 })).find(
            predicate,
          );
        return !!result;
      }, 60_000);
      assert(result);
      return result;
    };
    return {
      root,
      first,
      second,
      room,
      secondRoom,
      contact,
      tool,
      receives,
      async completePeerMessages() {
        const raw = await rawPeer();
        const result: {
          id: number;
          chatId: number;
          showPadlock: boolean;
          body: string | null | undefined;
        }[] = [];
        const chats = await raw.rpc.getChatlistEntries(id, null, null, null);
        for (const chat of chats) {
          const messages = await raw.rpc.getMessages(
            id,
            await raw.rpc.getMessageIds(id, chat, false, false),
          );
          for (const message of Object.values(messages)) {
            if (message?.kind !== "message") continue;
            const html = message.hasHtml
              ? await raw.rpc.getMessageHtml(id, message.id)
              : null;
            result.push({
              id: message.id,
              chatId: message.chatId,
              showPadlock: message.showPadlock,
              body: html === null ? message.text : decodePlaintextHtml(html),
            });
          }
        }
        return result;
      },
      async receivesComplete(text: string) {
        const raw = await rawPeer();
        let found: {
          id: number;
          chatId: number;
          showPadlock: boolean;
          body: string;
        } | undefined;
        await poll(async () => {
          const chats = await raw.rpc.getChatlistEntries(id, null, null, null);
          for (const chat of chats) {
            const messages = await raw.rpc.getMessages(
              id,
              await raw.rpc.getMessageIds(id, chat, false, false),
            );
            for (const message of Object.values(messages)) {
              if (message?.kind !== "message") continue;
              const html = message.hasHtml
                ? await raw.rpc.getMessageHtml(id, message.id)
                : null;
              const body = html === null
                ? message.text
                : decodePlaintextHtml(html);
              if (body === text) {
                found = {
                  id: message.id,
                  chatId: message.chatId,
                  showPadlock: message.showPadlock,
                  body,
                };
              }
            }
          }
          return !!found;
        }, 60_000);
        assert(found?.showPadlock);
        return found!;
      },
      releaseWaitResponses: () => waits.resolve(),
      failReadResponses: (enabled: boolean) => {
        readFailure.enabled = enabled;
      },
      rejectedReads: () => readFailure.rejected,
      holdWaitResponses: () => {
        waits = Promise.withResolvers<void>();
      },
      async quotedReply(text: string, seed: string, roomId = room) {
        const source = await receives(seed);
        const raw = await rawPeer();
        await raw.rpc.sendMsg(id, source.chatId, {
          text,
          html: null,
          viewtype: "Text",
          file: null,
          filename: null,
          location: null,
          overrideSenderName: "J4 canonical peer override",
          quotedMessageId: source.id,
          quotedText: null,
        });
        return await incoming(roomId, (m) => !m.fromSelf && m.text === text);
      },
      async forwardedReply(seed: string, roomId = room) {
        const source = await receives(seed);
        const raw = await rawPeer();
        await raw.rpc.forwardMessages(id, [source.id], source.chatId);
        return await incoming(
          roomId,
          (m) => !m.fromSelf && m.isForwarded && m.text === seed,
        );
      },
      async htmlReply(marker: string, seed: string, roomId = room) {
        const source = await receives(seed);
        const raw = await rawPeer();
        await raw.rpc.sendMsg(id, source.chatId, {
          text: marker,
          html:
            `<html><body><table><tr><td>${marker}</td></tr></table></body></html>`,
          viewtype: "Text",
          file: null,
          filename: null,
          location: null,
          overrideSenderName: null,
          quotedMessageId: null,
          quotedText: null,
        });
        return await incoming(
          roomId,
          (m) => !m.fromSelf && m.text.includes(marker),
        );
      },
      async partialReply(marker: string, seed: string, roomId = room) {
        const source = await receives(seed);
        const raw = await rawPeer();
        const file = `${root}/partial-${crypto.randomUUID()}.bin`;
        await Deno.writeFile(file, new Uint8Array(2 * 1024 * 1024), {
          createNew: true,
          mode: 0o600,
        });
        await raw.rpc.sendMsg(id, source.chatId, {
          text: marker,
          html: null,
          viewtype: null,
          file,
          filename: "partial-download.bin",
          location: null,
          overrideSenderName: null,
          quotedMessageId: null,
          quotedText: null,
        });
        return await incoming(
          roomId,
          (m) => !m.fromSelf && m.text.includes(marker),
        );
      },
      async addMember(seed: string, roomId = room) {
        const source = await receives(seed);
        const raw = await rawPeer();
        const invitation = await second.service.app.account.inviteLink();
        const qr = await raw.rpc.checkQr(id, invitation);
        assertEquals(qr.kind, "askVerifyContact");
        if (qr.kind !== "askVerifyContact") {
          throw new Error("Unexpected second invitation");
        }
        await raw.rpc.secureJoin(id, invitation);
        await poll(() => joined.includes(qr.contact_id), 60_000);
        const before = new Set(
          (await first.service.app.chats.messages(roomId)).map((m) => m.id),
        );
        await raw.rpc.addContactToChat(id, source.chatId, qr.contact_id);
        return await incoming(
          roomId,
          (m) => !before.has(m.id) && !m.fromSelf && m.isInfo,
        );
      },
      async reply(text: string, seed: string, roomId = room) {
        const received = await receives(seed);
        await peer!.call((rpc) =>
          rpc.miscSendTextMessage(id, received.chatId, text)
        );
        let message:
          | Awaited<ReturnType<typeof first.service.app.chats.messages>>[number]
          | undefined;
        await poll(async () => {
          message =
            (await first.service.app.chats.messages(roomId, { limit: 100 }))
              .find((m) => m.text === text);
          return !!message;
        }, 60_000);
        assert(message);
        assert(!message.fromSelf && message.encrypted);
        return message;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
