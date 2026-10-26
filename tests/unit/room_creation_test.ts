// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type CoreContact,
  type CoreRpc,
  CoreUnavailable,
} from "../../src/core/client.ts";
import { AccountService } from "../../src/messaging/account.ts";
import { RoomsService } from "../../src/messaging/rooms.ts";
import { ChangeHub } from "../../src/events.ts";
import { FakeCore } from "./fake_core.ts";

function fixture() {
  let contacts = [42, 43].map((id) => ({
    id,
    isBlocked: false,
    isKeyContact: true,
    e2eeAvail: true,
  } as CoreContact));
  const members = new Set([1]);
  let promoted = false, self = true, behavior = "normal", readFails = false;
  const core = new FakeCore({
    getAllAccountIds: () => Promise.resolve([7]),
    isConfigured: () => Promise.resolve(true),
    getContacts: () => Promise.resolve(contacts),
    createGroupChat: () => {
      if (behavior === "unknown") throw new Error("private core path");
      return Promise.resolve(99);
    },
    addContactToChat: (_account, _chat, member) => {
      if (behavior === "false-success") return Promise.resolve(null);
      if (behavior === "second-fails" && member === 43) {
        throw new Error("secret");
      }
      members.add(member);
      if (behavior === "mutates-throws") throw new Error("private path");
      return Promise.resolve(null);
    },
    getFullChatById: () => {
      if (readFails) throw new Error("private read failure");
      return Promise.resolve({
        id: 99,
        chatType: "Group",
        isEncrypted: true,
        selfInGroup: self,
        isUnpromoted: !promoted,
        contactIds: [...members],
      } as Awaited<ReturnType<CoreRpc["getFullChatById"]>>);
    },
  });
  return {
    core,
    members,
    rooms: new RoomsService(core, new AccountService(core, new ChangeHub())),
    contacts(value: typeof contacts) {
      contacts = value;
    },
    behavior(value: string) {
      behavior = value;
    },
    promoted() {
      promoted = true;
    },
    removeSelf() {
      self = false;
      members.delete(1);
    },
    readFails() {
      readFails = true;
    },
    creates: () =>
      core.calls.filter((c) => c.method === "createGroupChat").length,
  };
}

Deno.test("room whole-member fresh preflight rejects missing, blocked, non-key and unusable contacts before allocation", async () => {
  for (
    const invalid of [undefined, { isBlocked: true }, { isKeyContact: false }, {
      e2eeAvail: false,
    }]
  ) {
    const f = fixture();
    f.contacts(
      invalid
        ? [
          {
            id: 42,
            isBlocked: false,
            isKeyContact: true,
            e2eeAvail: true,
            ...invalid,
          } as CoreContact,
        ]
        : [],
    );
    await assertRejects(() => f.rooms.createRoom("Room", [42]));
    assertEquals(f.creates(), 0);
  }
  const f = fixture();
  await assertRejects(() => f.rooms.createRoom(" ", []));
  await assertRejects(() => f.rooms.createRoom("Room", [0]));
  assertEquals(f.creates(), 0);
});

Deno.test("zero, one and multiple selected peers create distinct Groups and deduplicate all intended members", async () => {
  for (const ids of [[], [42], [42, 43, 42]]) {
    const f = fixture();
    assertEquals(await f.rooms.createRoom(" Room ", ids), { chatId: 99 });
    assertEquals([...f.members], [...new Set([1, ...ids])]);
    assertEquals(
      f.core.calls.find((c) => c.method === "createGroupChat")?.args,
      [7, "Room", false],
    );
    assert(f.core.calls.some((c) => c.method === "getFullChatById"));
  }
});

Deno.test("known allocation survives nth-add failure, mutates-throws, false success and unreadable verification; explicit completion never creates", async () => {
  for (
    const behavior of [
      "second-fails",
      "mutates-throws",
      "false-success",
      "read-fails",
    ]
  ) {
    const f = fixture();
    f.behavior(behavior);
    if (behavior === "read-fails") f.readFails();
    const error = await assertRejects(() =>
      f.rooms.createRoom("Room", [42, 43])
    );
    const outcome = (error as Error & {
      outcome: {
        kind: string;
        chatId: number;
        missingContactIds: number[] | null;
      };
    }).outcome;
    assertEquals(outcome.kind, "incomplete");
    assertEquals(outcome.chatId, 99);
    assert(!JSON.stringify(outcome).includes("private"));
    assertEquals(f.creates(), 1);
    if (behavior === "read-fails") continue;
    const before = f.core.calls.filter((c) =>
      c.method === "addContactToChat"
    ).length;
    const missing = [42, 43].filter((id) => !f.members.has(id));
    assertEquals(outcome.missingContactIds, missing);
    f.behavior("normal");
    assertEquals(await f.rooms.completeRoom(99, [42, 43]), { chatId: 99 });
    assertEquals(f.creates(), 1);
    assertEquals(
      f.core.calls.filter((c) => c.method === "addContactToChat").slice(before)
        .map((c) => c.args[2]),
      missing,
    );
  }
});

Deno.test("same-ID completion rejects promoted and SELF-removed targets without membership writes", async () => {
  for (const state of ["promoted", "removed"]) {
    const f = fixture();
    if (state === "promoted") f.promoted();
    else f.removeSelf();
    const error = await assertRejects(() => f.rooms.completeRoom(99, [42, 43]));
    assertEquals(
      (error as Error & { outcome: { completionStopped: boolean } }).outcome
        .completionStopped,
      true,
    );
    assertEquals(f.creates(), 0);
    assertEquals(
      f.core.calls.filter((c) => c.method === "addContactToChat").length,
      0,
    );
  }
});

Deno.test("lost create acknowledgement is explicitly uncertain with no invented ID or write retry", async () => {
  const f = fixture();
  f.behavior("unknown");
  const error = await assertRejects(() => f.rooms.createRoom("Room", [42]));
  assertEquals(
    (error as Error & { outcome: { kind: string; chatId?: number } }).outcome
      .kind,
    "uncertain",
  );
  assertEquals(
    (error as Error & { outcome: { chatId?: number } }).outcome.chatId,
    undefined,
  );
  assertEquals(f.creates(), 1);
});

Deno.test("an ineligible second selected member prevents every create, and generation loss outside the callback retains an acknowledged ID", async () => {
  const invalid = fixture();
  invalid.contacts([
    {
      id: 42,
      isBlocked: false,
      isKeyContact: true,
      e2eeAvail: true,
    } as CoreContact,
  ]);
  await assertRejects(() => invalid.rooms.createRoom("Whole set", [42, 43]));
  assertEquals(invalid.creates(), 0);
  const f = fixture();
  const losing = {
    use: async <T>(fn: (rpc: CoreRpc) => Promise<T>): Promise<T> => {
      const value = await f.core.use(fn);
      if (f.creates()) throw new CoreUnavailable();
      return value;
    },
  };
  const rooms = new RoomsService(
    losing,
    new AccountService(losing, new ChangeHub()),
  );
  const error = await assertRejects(() => rooms.createRoom("Acknowledged", []));
  assertEquals(
    (error as Error & { outcome: { chatId: number; missingContactIds: null } })
      .outcome.chatId,
    99,
  );
  assertEquals(
    (error as Error & { outcome: { missingContactIds: null } }).outcome
      .missingContactIds,
    null,
  );
  assertEquals(f.creates(), 1);
});
