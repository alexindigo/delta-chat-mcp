// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { startDeltaChat } from "@deltachat/stdio-rpc-server";
import { once } from "node:events";
import { createCoreFacade } from "../../src/core/client.ts";
import { AccountService } from "../../src/messaging/account.ts";
import { RoomsService } from "../../src/messaging/rooms.ts";
import { ChangeHub } from "../../src/events.ts";
import { deadline, fixture } from "../support.ts";

Deno.test("stock 2.65 offline rooms with zero, one and two imported key peers are canonical encrypted Groups containing SELF", async () => {
  // Test-local stock client owns pseudo transports/vCards. Production facade
  // remains unchanged and exposes neither fixture preparation operation.
  const client = startDeltaChat(await fixture("room-native-core"), {
    disableEnvPath: true,
    muteStdErr: true,
  });
  const closed = Promise.all([
    once(client.transport.input, "close"),
    once(client.transport.output, "close"),
  ]);
  try {
    const rpc = client.rpc;
    await deadline(rpc.getSystemInfo());
    const id = await rpc.addAccount();
    await rpc.addPseudoTransport(id, "self@fixture.test");
    // v2.65 key.rs tests explicitly pair pseudo transport with configured_addr;
    // pseudo transport alone does not establish the primary self address.
    await rpc.setConfig(id, "configured_addr", "self@fixture.test");
    const ids: number[] = [];
    for (const name of ["first", "second"]) {
      const peer = await rpc.addAccount();
      await rpc.addPseudoTransport(peer, `${name}@fixture.test`);
      await rpc.setConfig(peer, "configured_addr", `${name}@fixture.test`);
      const card = await rpc.makeVcard(peer, [1]);
      ids.push(...await rpc.importVcardContents(id, card));
    }
    const facade = createCoreFacade(rpc);
    // The application owns one identity; fixture peers are deliberately outside
    // its account enumeration while all room operations hit the stock core.
    const core = {
      use: <T>(fn: (rpc: typeof facade) => Promise<T>) =>
        fn({ ...facade, getAllAccountIds: () => Promise.resolve([id]) }),
    };
    const rooms = new RoomsService(
      core,
      new AccountService(core, new ChangeHub()),
    );
    const created: number[] = [];
    for (const selected of [[], ids.slice(0, 1), [...ids, ids[0]]]) {
      const room = await rooms.createRoom("Native room", selected);
      const chat = await rpc.getFullChatById(id, room.chatId);
      assertEquals(chat.chatType, "Group");
      assert(chat.isEncrypted && chat.selfInGroup && chat.isUnpromoted);
      assertEquals(chat.isContactRequest, false);
      assertEquals(
        [...chat.contactIds].sort((a, b) => a - b),
        [...new Set([1, ...selected])].sort((a, b) => a - b),
      );
      assertEquals(await rooms.completeRoom(room.chatId, selected), room);
      created.push(room.chatId);
    }
    assertEquals(new Set(created).size, 3);
  } finally {
    client.close();
    await deadline(closed);
  }
});
