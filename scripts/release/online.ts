// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from "@std/path";
import { startTestPeer } from "../../src/core/test-peer.ts";
import { AccountService } from "../../src/messaging/account.ts";
import { ChangeHub } from "../../src/events.ts";
import type { CoreMessage } from "../../src/core/client.ts";
import { Artifact, start } from "./adapter.ts";
import {
  argument,
  deadline,
  poll,
  record,
  requireThat,
  sha256,
  withOwners,
  workspace,
} from "./common.ts";
import { api, connect, tool } from "./protocol.ts";

/** Fresh private stock-core peer; no staging/live identity or witness-profile changes. */
async function online() {
  const kind = Deno.args.includes("--binary") ? "binary" : "image";
  const target = kind === "binary"
    ? resolve(argument("--binary"))
    : argument("--image");
  const root = workspace(argument("--workspace"));
  await Deno.mkdir(root, { mode: 0o700 });
  const artifact = new Artifact(kind, target);
  try {
    const result = await withOwners(async (own) => {
      const service = await start(artifact, `${root}/service`);
      own(async () => {
        const shutdown = await service.stop();
        await Deno.writeTextFile(
          `${root}/shutdown.json`,
          JSON.stringify(shutdown),
        );
        record("online-owned-service-joined", shutdown);
      });
      const joined: number[] = [];
      const peer = await startTestPeer(`${root}/peer`, (event) => {
        if (
          event.kind === "SecurejoinJoinerProgress" && event.progress === 1000
        ) {
          joined.push(event.contactId);
        }
      });
      own(() => peer.close());
      const run = crypto.randomUUID(), relay = "ci-chatmail.testrun.org";
      await (await api(service.url, "/api/auth/setup", {
        method: "POST",
        body: { type: "public" },
      })).body?.cancel();
      const identity = await (await api(service.url, "/api/account", {
        method: "POST",
        body: { relay, displayName: `Packaged ${run}` },
      })).json();
      requireThat(identity.configured, "Packaged identity setup failed");
      const account = new AccountService(
        { use: (op) => peer.call(op) },
        new ChangeHub(),
      );
      const p = await account.create({
        relay,
        displayName: `Stock peer ${run}`,
      });
      requireThat(
        p.configured && p.accountId !== null,
        "Stock peer setup failed",
      );
      const id = p.accountId;
      await peer.call((rpc) => rpc.setConfig(id, "mdns_enabled", "1"));
      const invite = await (await api(service.url, "/api/account/invite"))
        .json();
      requireThat(
        typeof invite.link === "string",
        "Packaged invitation missing",
      );
      const qr = await peer.call((rpc) => rpc.checkQr(id, invite.link));
      requireThat(qr.kind === "askVerifyContact", "Wrong securejoin QR");
      const chat = await peer.call((rpc) => rpc.secureJoin(id, invite.link));
      await poll(() => joined.includes(qr.contact_id), 120000);
      const client = await connect(service.url);
      own(() => deadline(client.close(), 15000));
      let contact: {
        id: number;
        keyContact: boolean;
        encryptionAvailable: boolean;
      } | undefined;
      await poll(async () => {
        const { contacts } = await tool<
          {
            contacts: {
              id: number;
              name: string;
              keyContact: boolean;
              encryptionAvailable: boolean;
            }[];
          }
        >(client!, "list_contacts");
        contact = contacts.find((c) => c.name === `Stock peer ${run}`);
        return !!contact?.keyContact && contact.encryptionAvailable;
      }, 120000);
      record("packaged-and-stock-identities-paired", {
        identities: 2,
        fresh: true,
      });
      const outbound = `Packaged outbound ${run}`;
      const sent = await tool<{ chat_id: number; message_id: number }>(
        client,
        "send_message",
        { contact_id: contact!.id, text: outbound },
      );
      let received: CoreMessage | undefined;
      await poll(async () => {
        const ids = await peer.call((rpc) =>
          rpc.getMessageIds(id, chat, false, false)
        );
        const rows = await peer.call((rpc) => rpc.getMessages(id, ids));
        received = Object.values(rows).flatMap((m) =>
          m.kind === "message" ? [m] : []
        ).find((m) => m.text === outbound);
        return !!received;
      }, 120000);
      requireThat(
        received?.showPadlock && received.text === outbound,
        "Stock peer must decrypt exact outbound text",
      );
      const reply = `Stock reply ${run}`;
      await peer.call((rpc) => rpc.miscSendTextMessage(id, chat, reply));
      let incoming:
        | { text: string; encrypted: boolean; fromSelf: boolean }
        | undefined;
      await poll(async () => {
        const history = await tool<
          {
            messages: { text: string; encrypted: boolean; fromSelf: boolean }[];
          }
        >(client!, "read_messages", { chat_id: sent.chat_id, limit: 100 });
        incoming = history.messages.find((m) => m.text === reply);
        return !!incoming;
      }, 120000);
      requireThat(
        incoming?.encrypted && !incoming.fromSelf,
        "Actual packaged MCP history must observe encrypted peer reply",
      );
      const result = {
        passed: true,
        target: kind,
        uniqueRun: run,
        identities: 2,
        relay,
        outboundDecryptedByStockPeer: true,
        inboundEncryptedThroughMcpHistory: true,
        outboundSha256: await sha256(new TextEncoder().encode(outbound)),
        inboundSha256: await sha256(new TextEncoder().encode(reply)),
      };
      return result;
    });
    await Deno.writeTextFile(
      `${root}/result.json`,
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    record("packaged-encrypted-roundtrip", result);
  } catch (error) {
    await Deno.writeTextFile(
      `${root}/failure.json`,
      JSON.stringify({ error: String(error) }),
      { mode: 0o600 },
    );
    throw error;
  }
}
if (import.meta.main) await online();
