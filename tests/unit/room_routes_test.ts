// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { pathfinder } from "@pathfinder/pathfinder";
import { authFixture } from "../auth_support.ts";
import { RoomSetupError } from "../../src/messaging/room-outcome.ts";
import { toolResult } from "../../src/mcp/result.ts";

Deno.test("discovered room cookie routes enforce own Origin, reject Bearer and preserve safe partial/uncertain facts; public remains open", async () => {
  for (const mode of ["password", "public"] as const) {
    const f = await authFixture(), calls: unknown[] = [];
    try {
      const token = await f.auth.setup({
        type: mode,
        username: "operator",
        password: "private-room-fixture",
      });
      const cookie = token ? f.auth.cookie(token).split(";")[0] : "";
      const rooms = {
        createRoom(name: string, ids: number[]) {
          calls.push(["create", name, ids]);
          return Promise.resolve({ chatId: 99 });
        },
        completeRoom(id: number, ids: number[]) {
          calls.push(["complete", id, ids]);
          return Promise.resolve({ chatId: id });
        },
      };
      const route = await pathfinder({
        roots: [new URL("../../src/http/routes/", import.meta.url)],
        app: { auth: f.auth, apiKeys: f.apiKeys, log: f.log, rooms },
      });
      const request = (
        path = "/api/rooms",
        body: unknown = { name: "Room", contactIds: [42] },
        headers: Record<string, string> = {},
      ) =>
        route(
          new Request(`http://relay${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          }),
        );
      if (mode === "password") {
        const key = await f.apiKeys.create("Room route Bearer fixture");
        assertEquals((await request()).status, 403);
        assertEquals(
          (await request(undefined, undefined, {
            origin: "http://relay",
            authorization: `Bearer ${key.key}`,
          })).status,
          401,
        );
        assertEquals(
          (await request(undefined, undefined, {
            cookie,
            origin: "http://evil",
          })).status,
          403,
        );
        assertEquals(calls, []);
      }
      const headers: Record<string, string> = mode === "password"
        ? { cookie, origin: "http://relay" }
        : {};
      assertEquals(
        await (await request(undefined, undefined, headers)).json(),
        { chatId: 99 },
      );
      assertEquals(
        await (await request(
          "/api/rooms/99/complete",
          { contactIds: [42, 43] },
          headers,
        )).json(),
        { chatId: 99 },
      );
      assertEquals(calls, [["create", "Room", [42]], ["complete", 99, [
        42,
        43,
      ]]]);
      for (
        const body of [
          { name: " ", contactIds: [] },
          { name: "Room", contactIds: [0] },
          { name: "Room", contactIds: Array(101).fill(42) },
          { name: "Room", contactIds: [], extra: true },
        ]
      ) assertEquals((await request(undefined, body, headers)).status, 400);
      for (
        const outcome of [
          {
            kind: "incomplete" as const,
            chatId: 99,
            intendedContactIds: [42, 43],
            missingContactIds: [43],
            completionStopped: false,
            message: "Same room only",
          },
          { kind: "uncertain" as const, message: "Inspect conversations" },
        ]
      ) {
        rooms.createRoom = () => Promise.reject(new RoomSetupError(outcome));
        const response = await request(undefined, undefined, headers);
        assertEquals(response.status, 409);
        assertEquals((await response.json()).room, outcome);
        const mcp = await toolResult(() =>
          Promise.reject(new RoomSetupError(outcome))
        );
        assert(mcp.isError);
        assertEquals(mcp.structuredContent, {
          error: outcome.kind,
          room: outcome,
        });
        assertEquals(
          mcp.content[0].text,
          JSON.stringify(mcp.structuredContent),
        );
      }
    } finally {
      f.close();
    }
  }
});
