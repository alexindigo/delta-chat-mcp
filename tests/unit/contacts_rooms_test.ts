// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { AccountService } from "../../src/messaging/account.ts";
import { ContactsService } from "../../src/messaging/contacts.ts";
import { RoomsService } from "../../src/messaging/rooms.ts";
import { ChangeHub } from "../../src/events.ts";
import { FakeCore } from "./fake_core.ts";

Deno.test("contacts expose supported encryption state, validate invites and handle requests", async () => {
  const core = new FakeCore({
    getAllAccountIds: () => Promise.resolve([7]),
    isConfigured: () => Promise.resolve(true),
    getContacts: () =>
      Promise.resolve([{
        id: 42,
        address: "",
        displayName: "Peer",
        isKeyContact: true,
        e2eeAvail: true,
        isBlocked: false,
        name: "Peer",
        authName: "Peer",
        status: "",
        color: "#123456",
        profileImage: null,
        lastSeen: 0,
        freshness: "Normal",
        isBot: false,
      }]),
    checkQr: (_id, link) =>
      Promise.resolve(
        link === "fixture-invite"
          ? {
            kind: "askVerifyContact",
            contact_id: 42,
            fingerprint: "fixture",
            invitenumber: "fixture",
            authcode: "fixture",
            is_v3: true,
          }
          : { kind: "text", text: "fixture" },
      ),
    secureJoin: () => Promise.resolve(99),
    acceptChat: () => Promise.resolve(null),
    blockChat: () => Promise.resolve(null),
  });
  const contacts = new ContactsService(
    core,
    new AccountService(core, new ChangeHub()),
  );
  assertEquals(await contacts.list(), [{
    id: 42,
    address: "",
    displayName: "Peer",
    isBlocked: false,
    isKeyContact: true,
    e2eeAvail: true,
  }]);
  assertEquals(await contacts.joinByInvite("fixture-invite"), { chatId: 99 });
  await assertRejects(
    () => contacts.joinByInvite("arbitrary-text"),
    Error,
    "Not a SecureJoin",
  );
  assertEquals(
    core.calls.filter((call) => call.method === "secureJoin").length,
    1,
  );
  await contacts.accept(99);
  await contacts.block(99);
  assertEquals(
    core.calls.filter((call) =>
      ["acceptChat", "blockChat"].includes(call.method)
    ),
    [{ method: "acceptChat", args: [7, 99] }, {
      method: "blockChat",
      args: [7, 99],
    }],
  );
});
Deno.test("rooms use current group creation API and add all intended members", async () => {
  const members: number[] = [];
  const core = new FakeCore({
    getAllAccountIds: () => Promise.resolve([7]),
    isConfigured: () => Promise.resolve(true),
    createGroupChat: () => Promise.resolve(99),
    addContactToChat: (_id, _chat, member) => {
      members.push(member);
      return Promise.resolve(null);
    },
  });
  const rooms = new RoomsService(
    core,
    new AccountService(core, new ChangeHub()),
  );
  assertEquals(await rooms.createRoom("Fixture", [42, 43, 42]), { chatId: 99 });
  assertEquals(members, [42, 43]);
  assertEquals(core.calls.find((call) => call.method === "createGroupChat"), {
    method: "createGroupChat",
    args: [7, "Fixture", false],
  });
  await assertRejects(
    () => rooms.createRoom("Fixture", [-1]),
    Error,
    "Invalid core ID",
  );
  assertEquals(
    core.calls.filter((call) => call.method === "createGroupChat").length,
    1,
  );
});
