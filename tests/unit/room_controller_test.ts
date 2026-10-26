// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { type RoomApi, Rooms } from "../../web/src/rooms.ts";
import { ApiError } from "../../web/src/api.ts";
import type { Contact } from "../../web/src/messaging-types.ts";

function fixture() {
  const contacts: Contact[] = [42, 43].map((id) => ({
    id,
    address: `${id}@fixture.test`,
    displayName: `Peer ${id}`,
    isBlocked: false,
    isKeyContact: true,
    e2eeAvail: true,
  }));
  const calls: unknown[] = [], navigated: number[] = [];
  let refreshes = 0;
  const api: RoomApi = {
    contacts: () => Promise.resolve({ contacts }),
    createRoom: (name, ids) => {
      calls.push(["create", name, ids]);
      return Promise.resolve({ chatId: 99 });
    },
    completeRoom: (id, ids) => {
      calls.push(["complete", id, ids]);
      return Promise.resolve({ chatId: id });
    },
  };
  const rooms = new Rooms(api, () => {}, (id) => navigated.push(id), () => {
    refreshes++;
    return Promise.resolve();
  }, () => {});
  return { api, rooms, contacts, calls, navigated, refreshes: () => refreshes };
}
Deno.test("room controller retains fields and disappeared selections across close/history, validates name and blocks double-submit", async () => {
  const f = fixture();
  f.rooms.open();
  await f.rooms.load();
  await f.rooms.submit();
  assertEquals(f.calls.length, 0);
  f.rooms.name("Room");
  f.rooms.toggle(42);
  f.rooms.close();
  assert(f.rooms.dirty);
  f.contacts.splice(0, 1);
  f.rooms.open();
  await f.rooms.load();
  assertEquals(f.rooms.state.selected, [42]);
  assert(f.rooms.state.contacts.find((c) => c.id === 42)?.unavailable);
  const pending = Promise.withResolvers<{ chatId: number }>();
  let creates = 0;
  f.api.createRoom = () => {
    creates++;
    return pending.promise;
  };
  const request = f.rooms.submit();
  await f.rooms.submit();
  f.rooms.name("overwrite");
  f.rooms.toggle(43);
  assertEquals(f.rooms.state.name, "Room");
  assertEquals(f.rooms.state.selected, [42]);
  pending.resolve({ chatId: 123 });
  await request;
  assertEquals(creates, 1);
  assertEquals(f.navigated, [123]);
  assertEquals(f.rooms.dirty, false);
});
Deno.test("room partial recovery keeps input and known ID, uses only explicit same-ID completion and navigates once", async () => {
  const f = fixture();
  f.rooms.open();
  await f.rooms.load();
  f.rooms.name("Room");
  f.rooms.toggle(42);
  f.rooms.toggle(43);
  f.api.createRoom = () =>
    Promise.reject(
      new ApiError(409, "Incomplete", {
        kind: "incomplete",
        chatId: 99,
        intendedContactIds: [42, 43],
        missingContactIds: [43],
        completionStopped: false,
        message: "Retry same room",
      }),
    );
  await f.rooms.submit();
  f.rooms.close();
  f.rooms.open();
  await f.rooms.submit();
  assertEquals(f.navigated, []);
  assertEquals(f.rooms.state.name, "Room");
  assertEquals(f.rooms.state.selected, [42, 43]);
  await f.rooms.complete();
  assertEquals(f.calls, [["complete", 99, [42, 43]]]);
  assertEquals(f.navigated, [99]);
  assertEquals(f.rooms.dirty, false);
});
Deno.test("room transport uncertainty retains input, refetches conversations and requires explicit duplicate acknowledgement", async () => {
  const f = fixture();
  f.rooms.name("Room");
  let creates = 0;
  f.api.createRoom = () => {
    creates++;
    return Promise.reject(new ApiError(0, "Timeout"));
  };
  await f.rooms.submit();
  assertEquals(f.rooms.state.outcome?.kind, "uncertain");
  assertEquals(f.refreshes(), 1);
  assert(f.rooms.dirty);
  await f.rooms.submit();
  assertEquals(creates, 1);
  f.rooms.close();
  f.rooms.open();
  await f.rooms.submit();
  assertEquals(creates, 1);
  f.rooms.createAnother();
  assertEquals(f.rooms.state.name, "Room");
  await f.rooms.submit();
  assertEquals(creates, 2);
});
Deno.test("confirmed logout invalidates late room success, errors and contact results", async () => {
  for (const success of [true, false]) {
    const f = fixture(), pending = Promise.withResolvers<{ chatId: number }>();
    f.rooms.name("Room");
    f.api.createRoom = () => pending.promise;
    const work = f.rooms.submit();
    f.rooms.clear();
    if (success) pending.resolve({ chatId: 99 });
    else pending.reject(new ApiError(0, "Late"));
    await work;
    assertEquals(f.navigated, []);
    assertEquals(f.rooms.dirty, false);
    assertEquals(f.rooms.state.outcome, null);
  }
  const f = fixture(),
    contacts = Promise.withResolvers<{ contacts: Contact[] }>();
  f.api.contacts = () => contacts.promise;
  const load = f.rooms.load();
  f.rooms.clear();
  contacts.resolve({ contacts: f.contacts });
  await load;
  assertEquals(f.rooms.state.contacts, []);
  assertEquals(f.rooms.state.loading, false);
});
