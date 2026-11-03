// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  Dispatcher,
  type DispatchRelay,
} from "../../integrations/opencode/dispatcher.ts";
import { OpenCode } from "../../integrations/opencode/opencode.ts";
import { Registry } from "../../integrations/opencode/registry.ts";
import { openSqlite } from "../../integrations/opencode/sqlite.ts";
import { RelayFailure } from "../../integrations/opencode/relay.ts";
import {
  type NativeMessage,
  object,
  type RelayMessage,
  type Subscription,
} from "../../integrations/opencode/types.ts";
import type { RegistryWriter } from "../../integrations/opencode/registry.ts";
import { deadline, fixture, poll } from "../support.ts";
import type {
  OwnerProcess,
  OwnerWitness,
} from "../../integrations/opencode/owner-witness.ts";

const seed: NativeMessage = {
  info: {
    id: "msg_seed",
    role: "user",
    agent: "selected",
    model: { providerID: "test", modelID: "model", variant: "default" },
    time: { created: 1 },
  },
  parts: [{ id: "prt_seed", type: "text", text: "native seed" }],
};
const message: RelayMessage = {
  id: 5,
  chatId: 42,
  fromContactId: 12,
  fromSelf: false,
  fromName: "Operator",
  fromAddress: "operator@example.invalid",
  isInfo: false,
  isBot: false,
  isForwarded: false,
  text: "canonical body",
  textComplete: true,
  timestamp: 1,
  state: "seen",
  hasAttachment: false,
};

async function world() {
  const root = await fixture("j4-dispatcher");
  let registry = new Registry(await openSqlite(`${root}/wake.sqlite`));
  const sub = registry.write((tx) =>
    tx.subscribe({
      session_id: "session",
      relay: "relay@example.invalid",
      chat_id: 42,
      directory: "/A",
      owner_server: "http://localhost:4097/",
      alias: "relay",
      message_id: 90,
    }, 1)
  );
  registry.write((tx) => tx.recordBatch(sub, 90, [5], [5], 2));
  const posts: { messageID: string; partID: string }[] = [];
  const postedDeliveries: string[] = [];
  const nativeCalls: string[] = [];
  let writes = 0;
  const instrument = (db: Registry) => {
    const original = db.write;
    db.write = function <T>(run: (tx: RegistryWriter) => T): T {
      writes++;
      return original.call(this, run) as T;
    };
  };
  instrument(registry);
  let rows: NativeMessage[] = [seed];
  let positive = false;
  let heldGET = false;
  let nativeReads = 0;
  let unreadable = false;
  let nativeMode: "idle" | "busy" | "reverted" | "error" = "idle";
  let lastBody: Record<string, unknown> | undefined;
  let historyMode: "normal" | "deleted-anchor" | "source-deleted" = "normal";
  const historyCalls: { after?: number; before?: number }[] = [];
  const input = (value: unknown) => object(value);
  const client = {
    session: {
      get: () =>
        nativeMode === "error"
          ? Promise.reject(new Error("Native session API failed"))
          : Promise.resolve({
            data: {
              id: "session",
              agent: "selected",
              model: { id: "model", providerID: "test", variant: "default" },
              ...(nativeMode === "reverted"
                ? { revert: { messageID: "msg_operator" } }
                : {}),
            },
          }),
      status: () =>
        Promise.resolve({
          data: nativeMode === "busy" ? { session: { type: "busy" } } : {},
        }),
      messages: () => {
        nativeReads++;
        return Promise.resolve({ data: rows });
      },
      message: async (value: unknown) => {
        const options = input(value);
        if (heldGET) {
          await new Promise<void>((_, reject) => {
            const signal = options.signal as AbortSignal;
            if (signal.aborted) reject(signal.reason);
            else {signal.addEventListener(
                "abort",
                () => reject(signal.reason),
                { once: true },
              );}
          });
        }
        const id = object(options.path).messageID;
        const row = rows.find((r) => r.info.id === id);
        if (unreadable) {
          return { data: {}, response: new Response(null, { status: 200 }) };
        }
        return row
          ? { data: row }
          : { response: new Response(null, { status: 404 }) };
      },
      promptAsync: (value: unknown) => {
        const body = object(input(value).body);
        lastBody = body;
        const part = object((body.parts as unknown[])[0]);
        const deliveryID = String(
          object(object(part.metadata).deltaChatWake).deliveryId,
        );
        const stored = registry.submissions(deliveryID).at(
          -1,
        )!;
        // This observation happens at the API port, BEFORE any POST response.
        assertEquals(stored.message_id, body.messageID);
        assertEquals(stored.part_id, part.id);
        assertEquals(stored.state, "submitting");
        posts.push({
          messageID: String(body.messageID),
          partID: String(part.id),
        });
        postedDeliveries.push(deliveryID);
        if (positive) {
          rows = [seed, {
            info: {
              id: String(body.messageID),
              role: "user",
              time: { created: 3 },
            },
            parts: [{
              id: String(part.id),
              type: "text",
              text: String(part.text),
              metadata: object(part.metadata),
            }],
          }, {
            info: {
              id: "msg_answer",
              role: "assistant",
              parentID: String(body.messageID),
              finish: "stop",
              time: { created: 4, completed: 5 },
            },
            parts: [{ id: "prt_answer", type: "text", text: "answer" }],
          }];
        }
        return Promise.resolve({
          response: new Response(null, { status: 204 }),
        });
      },
    },
    tui: { showToast: () => Promise.resolve({ data: {} }) },
  };
  for (const [name, group] of Object.entries(client)) {
    const methods = group as unknown as Record<string, unknown>;
    for (const [method, original] of Object.entries(methods)) {
      if (typeof original !== "function") continue;
      methods[method] = (...args: unknown[]) => {
        nativeCalls.push(`${name}.${method}`);
        return Reflect.apply(original, group, args);
      };
    }
  }
  const relay: DispatchRelay = {
    identity: () => Promise.resolve(sub.relay),
    refreshNativeState: () => Promise.resolve(true),
    read: (_chat, after, _signal, before) => {
      historyCalls.push({ after, before });
      if (historyMode === "normal") {
        return Promise.resolve({ messages: [message] });
      }
      if (after !== undefined) {
        return Promise.reject(
          new RelayFailure("tool_error", false, "not_found", "application"),
        );
      }
      if (before === undefined) {
        return Promise.resolve({
          messages: [{ ...message, id: 7 }, { ...message, id: 2 }],
        });
      }
      return Promise.resolve({
        messages: before === 7 && historyMode === "deleted-anchor"
          ? [message]
          : [],
      });
    },
    call: () => Promise.resolve({ chats: [{ id: 42, name: "Room" }] }),
  };
  const make = (
    epoch: string,
    relays: ReadonlyMap<string, DispatchRelay> = new Map([["relay", relay]]),
    answerReady?: ConstructorParameters<typeof Dispatcher>[0]["answerReady"],
    process?: OwnerProcess,
    extra?: Pick<
      ConstructorParameters<typeof Dispatcher>[0],
      "enabled" | "settled"
    >,
  ) => {
    const lifetime = new AbortController();
    const holder = crypto.randomUUID();
    const dispatcher = new Dispatcher({
      registry: () => registry,
      opencode: new OpenCode(client, lifetime.signal),
      relays,
      answerReady,
      owner: sub.owner_server,
      directory: sub.directory,
      holder,
      epoch,
      process,
      signal: lifetime.signal,
      ...extra,
    });
    return { dispatcher, lifetime, holder };
  };
  return {
    get registry() {
      return registry;
    },
    sub,
    client,
    relay,
    posts,
    postedDeliveries,
    nativeCalls,
    nativeMode: (mode: typeof nativeMode) => {
      nativeMode = mode;
    },
    writes: () => writes,
    make,
    setPositive: () => {
      positive = true;
    },
    holdGET: () => {
      heldGET = true;
    },
    releaseGET: () => {
      heldGET = false;
    },
    reads: () => nativeReads,
    restoreRows: (history: NativeMessage[]) => {
      rows = history;
    },
    historyCalls,
    history: (mode: typeof historyMode) => {
      historyMode = mode;
    },
    async reopen() {
      registry.close();
      registry = new Registry(await openSqlite(`${root}/wake.sqlite`));
      instrument(registry);
    },
    publish(
      mode:
        | "missing"
        | "wrong"
        | "valid"
        | "deleted"
        | "takeover"
        | "unreadable",
    ) {
      unreadable = mode === "unreadable";
      if (!lastBody) throw new Error("No original POST");
      const part = object((lastBody.parts as unknown[])[0]);
      rows = mode === "deleted" ? [seed] : [seed, {
        info: {
          id: String(lastBody.messageID),
          role: "user",
          time: { created: 3 },
        },
        parts: mode === "missing" ? [] : [{
          id: String(part.id),
          type: "text",
          text: String(part.text),
          metadata: mode === "wrong"
            ? {
              deltaChatWake: {
                ...object(object(part.metadata).deltaChatWake),
                relay: "wrong@example.invalid",
              },
            }
            : object(part.metadata),
        }],
      }];
      if (mode === "valid") {
        rows.push({
          info: {
            id: "msg_answer",
            role: "assistant",
            parentID: String(lastBody.messageID),
            finish: "stop",
            time: { created: 4, completed: 5 },
          },
          parts: [{ id: "prt_answer", type: "text", text: "answer" }],
        });
      }
      if (mode === "takeover") {
        rows.push({
          info: { id: "msg_operator", role: "user", time: { created: 4 } },
          parts: [{
            id: "prt_operator",
            type: "text",
            text: "new native intent",
          }],
        }, {
          info: {
            id: "msg_operator_answer",
            role: "assistant",
            parentID: "msg_operator",
            finish: "stop",
            time: { created: 5, completed: 6 },
          },
          parts: [{
            id: "prt_operator_answer",
            type: "text",
            text: "native answer",
          }],
        });
      }
    },
  };
}

Deno.test("J4 stable IDs commit before POST;204 stays uncertain;native cancellation joins;only changed epoch retries absent original", async () => {
  const f = await world();
  const epoch = crypto.randomUUID();
  const first = f.make(epoch);
  try {
    f.holdGET();
    first.dispatcher.kick("session");
    await poll(() => f.registry.deliveries()[0].state === "submitted");
    const original = f.registry.submissions(f.registry.deliveries()[0].id)[0];
    assertEquals(f.posts.length, 1);
    first.lifetime.abort();
    await deadline(first.dispatcher.close(), 1000);
    assertEquals(f.registry.deliveries()[0].state, "submitted");
    f.releaseGET();
    const same = f.make(epoch);
    const before = f.reads();
    same.dispatcher.kick("session");
    await poll(() => f.reads() > before);
    await same.dispatcher.close();
    assertEquals(
      f.posts.length,
      1,
      "same epoch must never resubmit an uncertain fork",
    );
    f.setPositive();
    const restarted = f.make(crypto.randomUUID());
    restarted.dispatcher.kick("session");
    await poll(() => f.registry.deliveries()[0].state === "admitted");
    await restarted.dispatcher.close();
    assertEquals(f.posts, [{
      messageID: original.message_id,
      partID: original.part_id,
    }, { messageID: original.message_id, partID: original.part_id }]);
    assertEquals(
      f.registry.submissions(f.registry.deliveries()[0].id)[0].attempts,
      2,
    );
  } finally {
    first.lifetime.abort();
    await first.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("J4 any positive native ID permanently forbids replay despite missing/conflicting part,local deletion and a new epoch", async () => {
  for (const mode of ["missing", "wrong", "unreadable"] as const) {
    const f = await world();
    const first = f.make(crypto.randomUUID());
    try {
      first.dispatcher.kick("session");
      await poll(() => f.posts.length === 1);
      f.publish(mode);
      const id = f.registry.deliveries()[0].id;
      await poll(() => f.registry.execution(id, 0)?.observedAt != null);
      const observed = f.registry.execution(id, 0)!.observedAt;
      const original = f.registry.submissions(id)[0];
      assertThrows(() =>
        f.registry.write((tx) =>
          tx.updateSubmission({
            ...original,
            attempts: original.attempts + 1,
            submit_epoch: crypto.randomUUID(),
            state: "submitting",
          })
        )
      );
      first.lifetime.abort();
      await first.dispatcher.close();
      assertEquals(f.registry.deliveries()[0].state, "submitted");
      f.publish("deleted");
      await f.reopen();
      const restarted = f.make(crypto.randomUUID());
      const before = f.reads();
      restarted.dispatcher.kick("session");
      await poll(() => f.reads() > before);
      await restarted.dispatcher.close();
      assertEquals(
        f.posts.length,
        1,
        "a later negative lookup cannot erase positive existence",
      );
      assertEquals(f.registry.execution(id, 0)!.observedAt, observed);
      f.publish("valid");
      const repaired = f.make(crypto.randomUUID());
      repaired.dispatcher.kick("session");
      await poll(() => f.registry.deliveries()[0].state === "admitted");
      repaired.lifetime.abort();
      await repaired.dispatcher.close();
      assertEquals(
        f.posts.length,
        1,
        "later matching part confirms the original,never overwrites it",
      );
      assertEquals(f.registry.submissions(id)[0].attempts, 1);
    } finally {
      first.lifetime.abort();
      await first.dispatcher.close();
      f.registry.close();
    }
  }
});

Deno.test("J4 late original is superseded by newer native input even when confirmation follows its idle hint", async () => {
  const f = await world();
  const runtime = f.make(crypto.randomUUID());
  try {
    runtime.dispatcher.kick("session");
    await poll(() => f.posts.length === 1);
    f.publish("takeover");
    await poll(() => f.registry.deliveries()[0].state === "admitted");
    runtime.dispatcher.kick("session");
    await poll(() =>
      f.registry.deliveries()[0].state === "superseded_by_native_input"
    );
    assertEquals(
      f.registry.deliveries()[0].superseding_message_id,
      "msg_operator",
    );
    assertEquals(f.posts.length, 1);
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("J4 deleted body anchor uses canonical before_id pages;exhausted actual history is source_deleted without submission", async () => {
  for (const mode of ["deleted-anchor", "source-deleted"] as const) {
    const f = await world();
    const runtime = f.make(crypto.randomUUID());
    try {
      f.history(mode);
      f.setPositive();
      runtime.dispatcher.kick("session");
      await poll(() =>
        f.registry.deliveries()[0].state ===
          (mode === "deleted-anchor" ? "admitted" : "source_deleted")
      );
      await runtime.dispatcher.close();
      assertEquals(f.historyCalls.slice(0, 3), [
        { after: 90, before: undefined },
        { after: undefined, before: undefined },
        { after: undefined, before: 7 },
      ]);
      assertEquals(f.posts.length, mode === "deleted-anchor" ? 1 : 0);
    } finally {
      runtime.lifetime.abort();
      await runtime.dispatcher.close();
      f.registry.close();
    }
  }
});

Deno.test("J4 review room readiness is not a native reservation;uncertain originals remain session barriers", async () => {
  const cases: {
    name: string;
    state: Subscription["state"];
    edge?: "missing" | "disabled" | "failure" | "identity";
    epoch?: "same" | "new";
    seen?: boolean;
    answered?: boolean;
    allowB: boolean;
  }[] = [
    { name: "paused room", state: "paused", allowB: true },
    {
      name: "blocked room same alias",
      state: "blocked_discontinuity",
      allowB: true,
    },
    { name: "unroutable room", state: "unroutable", allowB: true },
    { name: "unsubmitted left room", state: "left", allowB: true },
    { name: "unsubmitted orphaned room", state: "orphaned", allowB: true },
    { name: "missing edge", state: "active", edge: "missing", allowB: true },
    { name: "disabled edge", state: "active", edge: "disabled", allowB: true },
    {
      name: "repeatable read failure",
      state: "active",
      edge: "failure",
      allowB: true,
    },
    {
      name: "identity mismatch",
      state: "active",
      edge: "identity",
      allowB: true,
    },
    { name: "left dead original", state: "left", epoch: "new", allowB: true },
    {
      name: "orphaned dead original",
      state: "orphaned",
      epoch: "new",
      allowB: true,
    },
    {
      name: "left same-process original",
      state: "left",
      epoch: "same",
      allowB: false,
    },
    {
      name: "paused same-process original",
      state: "paused",
      epoch: "same",
      allowB: false,
    },
    {
      name: "blocked same-process original",
      state: "blocked_discontinuity",
      epoch: "same",
      allowB: false,
    },
    {
      name: "left positively observed original",
      state: "left",
      epoch: "new",
      seen: true,
      allowB: false,
    },
    {
      name: "answered execution awaiting transport",
      state: "paused",
      epoch: "same",
      answered: true,
      allowB: true,
    },
  ];
  for (const item of cases) {
    const f = await world();
    const epoch = crypto.randomUUID();
    const a = f.registry.deliveries()[0];
    const originalEpoch = item.epoch === "new" ? crypto.randomUUID() : epoch;
    let bID = "";
    f.registry.write((tx) => {
      if (item.epoch) {
        const sub = tx.allocateSubmission(
          a.id,
          originalEpoch,
          0,
          10,
          seed.info.id,
        );
        tx.updateSubmission({
          ...sub,
          state: item.answered ? "admitted" : "submitted",
          updated_at: 11,
        });
        if (item.seen || item.answered) tx.observeNativeID(a.id, 0, 12);
        if (item.answered) {
          tx.recordAnswer(a.id, 0, {
            messageID: "msg_old_answer",
            partIDs: ["prt_old_answer"],
          }, 13);
        }
      }
      tx.putSubscription({ ...tx.subscription(f.sub)!, state: item.state });
      const b = tx.subscribe({
        session_id: "session",
        relay: f.sub.relay,
        chat_id: 43,
        directory: f.sub.directory,
        owner_server: f.sub.owner_server,
        alias: item.edge ? "other" : "relay",
        message_id: 91,
      }, 20);
      tx.recordBatch(b, 91, [6], [6], 21);
    });
    bID = f.registry.deliveries().find((d) => d.chat_id === 43)!.id;
    const normal: DispatchRelay = {
      identity: () => Promise.resolve(f.sub.relay),
      refreshNativeState: () => Promise.resolve(true),
      read: (chat) =>
        Promise.resolve({
          messages: [{ ...message, id: chat === 43 ? 6 : 5, chatId: chat }],
        }),
      call: () =>
        Promise.resolve({
          chats: [{ id: 42, name: "A" }, { id: 43, name: "B" }],
        }),
    };
    const edge: DispatchRelay = {
      ...normal,
      identity: () =>
        Promise.resolve(
          item.edge === "identity" ? "other@example.invalid" : f.sub.relay,
        ),
      refreshNativeState: () => Promise.resolve(item.edge !== "disabled"),
      read: () =>
        item.edge === "failure"
          ? Promise.reject(new RelayFailure("uncertain", false))
          : Promise.resolve({ messages: [message] }),
    };
    const relays = new Map<string, DispatchRelay>([["other", normal]]);
    if (item.edge !== "missing") relays.set("relay", item.edge ? edge : normal);
    f.setPositive();
    const runtime = f.make(epoch, relays);
    try {
      runtime.dispatcher.kick("session");
      if (item.allowB) await poll(() => f.postedDeliveries.includes(bID));
      else await poll(() => f.reads() > 0);
      await runtime.dispatcher.close();
      assertEquals(f.postedDeliveries, item.allowB ? [bID] : [], item.name);
      const finalA = f.registry.deliveries().find((d) => d.id === a.id)!;
      if (
        item.epoch === "new" && !item.seen &&
        ["left", "orphaned"].includes(item.state)
      ) assertEquals(finalA.state, "cancelled", item.name);
      if (item.epoch === "same" && !item.answered) {
        assertEquals(finalA.state, "submitted", item.name);
      }
      if (item.epoch) {
        assertEquals(f.registry.submissions(a.id)[0].attempts, 1, item.name);
      }
    } finally {
      runtime.lifetime.abort();
      await runtime.dispatcher.close();
      f.registry.close();
    }
  }
});

Deno.test("J4 continuation eligibility does not reserve a room-deferred slot;ready repair serializes before B", async () => {
  for (const mode of ["paused", "missing", "read-failure", "ready"] as const) {
    const f = await world();
    const epoch = crypto.randomUUID();
    const a = f.registry.deliveries()[0];
    const original = f.registry.write((tx) => {
      const submitted = tx.allocateSubmission(
        a.id,
        crypto.randomUUID(),
        0,
        2,
        seed.info.id,
      );
      tx.observeNativeID(a.id, 0, 3);
      tx.updateSubmission({ ...submitted, state: "admitted", updated_at: 3 });
      if (mode === "paused") {
        tx.putSubscription({ ...tx.subscription(f.sub)!, state: "paused" });
      }
      const b = tx.subscribe({
        session_id: "session",
        relay: f.sub.relay,
        chat_id: 43,
        directory: f.sub.directory,
        owner_server: f.sub.owner_server,
        alias: "other",
        message_id: 91,
      }, 4);
      tx.recordBatch(b, 91, [6], [6], 5);
      return submitted;
    });
    const b = f.registry.deliveries().find((d) => d.chat_id === 43)!;
    // Canonical admitted U is present but unanswered,with no later native input:
    // changed epoch MUST choose the continuation branch,not a missing-row exit.
    f.restoreRows([seed, {
      info: { id: original.message_id, role: "user", time: { created: 2 } },
      parts: [{
        id: original.part_id,
        type: "text",
        text: message.text,
        metadata: {
          deltaChatWake: {
            v: 1,
            deliveryId: a.id,
            relay: a.relay,
            chatId: a.chat_id,
            messageIds: a.message_ids,
          },
        },
      }],
    }]);
    const normal: DispatchRelay = {
      identity: () => Promise.resolve(f.sub.relay),
      refreshNativeState: () => Promise.resolve(true),
      read: (chat) =>
        Promise.resolve({
          messages: [{ ...message, id: chat === 43 ? 6 : 5, chatId: chat }],
        }),
      call: () =>
        Promise.resolve({
          chats: [{ id: 42, name: "A" }, { id: 43, name: "B" }],
        }),
    };
    const aEdge: DispatchRelay = {
      ...normal,
      read: () =>
        mode === "read-failure"
          ? Promise.reject(new RelayFailure("uncertain", false))
          : Promise.resolve({ messages: [message] }),
    };
    const relays = new Map<string, DispatchRelay>([["other", normal]]);
    if (mode !== "missing") relays.set("relay", aEdge);
    f.setPositive();
    const runtime = f.make(epoch, relays);
    try {
      runtime.dispatcher.kick("session");
      if (mode === "ready") {
        await poll(() =>
          f.registry.submissions(a.id).length === 2 &&
          f.registry.submissions(a.id)[1].state === "admitted"
        );
        assertEquals(
          f.postedDeliveries,
          [a.id],
          "ready A repair owns the slot until reconciled",
        );
        assertEquals(f.registry.submissions(b.id), []);
        const continuation = f.registry.submissions(a.id)[1];
        assertEquals(continuation.kind, "continuation");
        assertEquals(continuation.ordinal, 1);
        assertEquals(f.posts[0].messageID, continuation.message_id);
        runtime.dispatcher.kick("session");
      }
      await poll(() =>
        f.registry.submissions(b.id).at(-1)?.state === "admitted"
      );
      await runtime.dispatcher.close();
      assertEquals(
        f.postedDeliveries,
        mode === "ready" ? [a.id, b.id] : [b.id],
        mode,
      );
      assertEquals(
        f.registry.submissions(a.id)[0].message_id,
        original.message_id,
      );
      assertEquals(f.registry.submissions(a.id)[0].attempts, 1);
      assertEquals(
        f.registry.submissions(a.id).length,
        mode === "ready" ? 2 : 1,
      );
      assertEquals(
        f.posts.some((p) => p.messageID === original.message_id),
        false,
        "positive original never re-executes",
      );
    } finally {
      runtime.lifetime.abort();
      await runtime.dispatcher.close();
      f.registry.close();
    }
  }
});

Deno.test("J4 review1000stream/ordinary-part hints and no-work decision hints cause zero native calls or registry writes", async () => {
  const f = await world();
  f.registry.write((tx) =>
    tx.transition(f.registry.deliveries()[0].id, "open", "cancelled", 3, "left")
  );
  const runtime = f.make(crypto.randomUUID());
  const before = f.writes();
  try {
    for (let i = 0; i < 1000; i++) {
      runtime.dispatcher.event({
        event: {
          type: "message.part.delta",
          properties: { sessionID: "session", delta: "x" },
        },
      });
      runtime.dispatcher.event({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "session" } },
        },
      });
      runtime.dispatcher.event({
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "session", role: "assistant" } },
        },
      });
    }
    for (
      const type of [
        "session.idle",
        "session.status",
        "session.error",
        "session.updated",
        "session.deleted",
      ]
    ) {
      runtime.dispatcher.event({
        event: { type, properties: { sessionID: "session" } },
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(f.nativeCalls, []);
    assertEquals(f.writes(), before);
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("J4 review health notices use only supported toast regardless busy/idle/operator race,never native user input", async () => {
  const f = await world();
  const runtime = f.make(crypto.randomUUID());
  const before = f.writes();
  try {
    for (const phase of ["busy", "idle", "operator-race"]) {
      await runtime.dispatcher.notice({
        ...f.sub,
        state: "blocked_discontinuity",
      });
      assertEquals(f.posts, [], phase);
    }
    assertEquals(f.nativeCalls, [
      "tui.showToast",
      "tui.showToast",
      "tui.showToast",
    ]);
    assertEquals(f.writes(), before);
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("J4 review native busy,revert,API failure and global abort remain session scoped", async () => {
  for (const mode of ["busy", "reverted", "error", "abort"] as const) {
    const f = await world();
    f.registry.write((tx) => {
      const b = tx.subscribe({
        session_id: "session",
        relay: f.sub.relay,
        chat_id: 43,
        directory: f.sub.directory,
        owner_server: f.sub.owner_server,
        alias: "other",
        message_id: 91,
      }, 3);
      tx.recordBatch(b, 91, [6], [6], 4);
    });
    const normal: DispatchRelay = {
      identity: () => Promise.resolve(f.sub.relay),
      refreshNativeState: () => Promise.resolve(true),
      read: (chat) =>
        Promise.resolve({
          messages: [{ ...message, chatId: chat, id: chat === 43 ? 6 : 5 }],
        }),
      call: () => Promise.resolve({ chats: [] }),
    };
    const runtime = f.make(
      crypto.randomUUID(),
      new Map([["relay", normal], ["other", normal]]),
    );
    try {
      if (mode === "abort") runtime.lifetime.abort();
      else f.nativeMode(mode);
      runtime.dispatcher.kick("session");
      if (mode !== "abort") {
        await poll(() =>
          f.nativeCalls.includes(
            mode === "error" ? "tui.showToast" : "session.get",
          )
        );
      }
      await runtime.dispatcher.close();
      assertEquals(f.postedDeliveries, [], mode);
    } finally {
      runtime.lifetime.abort();
      await runtime.dispatcher.close();
      f.registry.close();
    }
  }
});

Deno.test("J4 review answered transport callback may repeat from registry without native slot writes or native APIs", async () => {
  const f = await world();
  const epoch = crypto.randomUUID();
  const d = f.registry.deliveries()[0];
  f.registry.write((tx) => {
    const sub = tx.allocateSubmission(d.id, epoch, 0, 10, seed.info.id);
    tx.observeNativeID(d.id, 0, 11);
    tx.updateSubmission({ ...sub, state: "admitted", updated_at: 12 });
    tx.recordAnswer(d.id, 0, {
      messageID: "msg_stored_answer",
      partIDs: ["prt_stored_answer"],
    }, 13);
  });
  let callbacks = 0;
  const runtime = f.make(epoch, new Map(), (_delivery, answer) => {
    callbacks++;
    assertEquals(answer, {
      messageID: "msg_stored_answer",
      partIDs: ["prt_stored_answer"],
    });
    return Promise.resolve();
  });
  const before = f.writes();
  try {
    runtime.dispatcher.kick("session");
    await poll(() => callbacks === 1);
    runtime.dispatcher.event({
      event: { type: "session.idle", properties: { sessionID: "session" } },
    });
    await poll(() => callbacks === 2);
    assertEquals(f.writes(), before);
    assertEquals(f.nativeCalls, []);
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

function controlledClock() {
  const originalNow = Date.now;
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let now = originalNow(), nextID = 0;
  const timers = new Map<number, { due: number; run(): void }>();
  const settle = async () => {
    for (let i = 0; i < 128; i++) await Promise.resolve();
  };
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    for (let turns = 0; turns < 128; turns++) {
      const due = [...timers].filter(([, timer]) => timer.due <= now)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].run();
      await settle();
    }
    await settle();
  };
  Date.now = () => now;
  globalThis.setTimeout =
    ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
      if (typeof handler !== "function") {
        throw new Error("Expected timer callback");
      }
      const id = ++nextID;
      timers.set(id, {
        due: now + delay,
        run: () => {
          Reflect.apply(handler, globalThis, args);
        },
      });
      return id;
    }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) timers.delete(id);
  }) as typeof clearTimeout;
  return {
    now: () => now,
    settle,
    advance,
    pending: () => timers.size,
    restore() {
      Date.now = originalNow;
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}

Deno.test("J4 lease expiry admits queued input at the recorded 90s deadline without an unrelated event", async () => {
  const f = await world();
  f.setPositive();
  const runtime = f.make(crypto.randomUUID());
  const clock = controlledClock();
  try {
    // Input is the persisted contended-lease state, not a shortened lease/test TTL.
    assertEquals(
      f.registry.write((tx) =>
        tx.acquireLease(
          "session",
          "crashed-owner",
          f.sub.owner_server,
          clock.now(),
        )
      ),
      true,
    );
    runtime.dispatcher.kick("session");
    await clock.settle();
    assertEquals(f.posts, [], "cannot steal a still-valid foreign lease");
    await clock.advance(89_999);
    assertEquals(f.posts, [], "the full default lease remains authoritative");
    await clock.advance(1);
    assertEquals(
      f.posts.length,
      1,
      "the queued input must reach the native port at lease expiry without another hint",
    );
    assertEquals(f.registry.deliveries()[0].state, "admitted");
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    assertEquals(clock.pending(), 0, "close cancels the owned wake");
    await clock.advance(300_000);
    assertEquals(f.posts.length, 1, "closed runtime cannot admit more work");
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    clock.restore();
    f.registry.close();
  }
});

Deno.test("J4 lease renewal is rechecked at expiry without stealing a live holder", async () => {
  const f = await world();
  f.setPositive();
  const runtime = f.make(crypto.randomUUID());
  const clock = controlledClock();
  try {
    assertEquals(
      f.registry.write((tx) =>
        tx.acquireLease(
          "session",
          "other-holder",
          f.sub.owner_server,
          clock.now(),
        )
      ),
      true,
    );
    runtime.dispatcher.kick("session");
    await clock.settle();
    await clock.advance(45_000);
    assertEquals(
      f.registry.write((tx) =>
        tx.acquireLease(
          "session",
          "other-holder",
          f.sub.owner_server,
          clock.now(),
        )
      ),
      true,
    );
    await clock.advance(45_000);
    assertEquals(
      f.posts,
      [],
      "original expiry cannot override a renewed lease",
    );
    await clock.advance(44_999);
    assertEquals(f.posts, []);
    await clock.advance(1);
    assertEquals(
      f.posts.length,
      1,
      "renewed recorded expiry eventually wakes the consumer",
    );
    assertEquals(f.registry.deliveries()[0].state, "admitted");
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    clock.restore();
    f.registry.close();
  }
});

Deno.test("J4 lease-free pending work retains the generic 300s fallback", async () => {
  const f = await world();
  f.nativeMode("busy");
  const runtime = f.make(crypto.randomUUID());
  const clock = controlledClock();
  try {
    runtime.dispatcher.kick("session");
    await clock.settle();
    await clock.advance(299_999);
    assertEquals(
      f.posts,
      [],
      "no arbitrary faster polling for generic deferral",
    );
    f.nativeMode("idle");
    f.setPositive();
    await clock.advance(1);
    assertEquals(f.posts.length, 1);
    assertEquals(f.registry.deliveries()[0].state, "admitted");
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    clock.restore();
    f.registry.close();
  }
});

Deno.test("J4 lease ordinary close releases its own holder immediately without waiting for expiry", async () => {
  const f = await world();
  f.setPositive();
  const runtime = f.make(crypto.randomUUID());
  try {
    runtime.dispatcher.kick("session");
    await poll(() => f.registry.deliveries()[0].state === "admitted");
    assertEquals(
      f.registry.write((tx) =>
        tx.acquireLease(
          "session",
          "next-owner",
          f.sub.owner_server,
          Date.now(),
        )
      ),
      false,
      "a different holder cannot acquire the live lease",
    );
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    assertEquals(
      f.registry.write((tx) =>
        tx.acquireLease(
          "session",
          "next-owner",
          f.sub.owner_server,
          Date.now(),
        )
      ),
      true,
      "the existing close contract must release the exact prior holder",
    );
    assertEquals(f.posts.length, 1);
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("idle fence hands off paused preparation immediately and blocks late callbacks and claim imports", async () => {
  const f = await world();
  const leaseHolders: string[] = [];
  const write = f.registry.write.bind(f.registry);
  f.registry.write = (run) =>
    write((tx) => {
      const acquire = tx.tryAcquireLease.bind(tx);
      tx.tryAcquireLease = (session, holder, ...args) => {
        leaseHolders.push(holder);
        return acquire(session, holder, ...args);
      };
      return run(tx);
    });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = f.relay.read;
  f.relay.read = async (...args) => {
    entered.resolve();
    await resume.promise;
    return await read(...args);
  };
  const old = f.make(crypto.randomUUID());
  const next = f.make(crypto.randomUUID());
  try {
    old.dispatcher.kick("session");
    await deadline(entered.promise);
    const acquire = () =>
      f.registry.write((tx) =>
        tx.tryAcquireLease(
          "session",
          next.holder,
          f.sub.owner_server,
          Date.now(),
        )
      );
    assertEquals(acquire().acquired, false);
    old.dispatcher.fence();
    const oldAcquisitions = leaseHolders.filter((holder) =>
      holder === old.holder
    ).length;
    assertEquals(
      acquire(),
      { acquired: true },
      "handoff precedes preparation resolution and abort",
    );
    assertEquals(old.lifetime.signal.aborted, false);
    const id = crypto.randomUUID();
    const claimant = f.registry.prepareRemoteClaim(id);
    f.registry.importRemote({
      id,
      session: "session",
      alias: "relay",
      relay: f.sub.relay,
      chat: 43,
      anchor: 91,
      ids: [6],
      token: "claim-token",
      claimant,
      owner: f.sub.owner_server,
      directory: f.sub.directory,
    });
    old.dispatcher.kick("session");
    old.dispatcher.all();
    assertEquals(
      old.dispatcher.event({
        event: { type: "session.idle", properties: { sessionID: "session" } },
      }),
      undefined,
    );
    resume.resolve();
    await deadline(old.dispatcher.close());
    assertEquals(
      leaseHolders.filter((holder) => holder === old.holder).length,
      oldAcquisitions,
      "late preparation never even attempts old-holder reacquisition",
    );
    assertEquals(f.posts, []);
    assertEquals(f.registry.submissions(id), []);
    assertEquals(
      acquire(),
      { acquired: true },
      "old close leaves foreign holder intact",
    );
    // Keep the late imported row deferred; successor consumes the original once.
    f.registry.write((tx) =>
      tx.putSubscription({
        ...tx.subscription({ ...f.sub, chat_id: 43 })!,
        state: "paused",
      })
    );
    f.setPositive();
    next.dispatcher.kick("session");
    await poll(() =>
      f.registry.deliveries().find((d) => d.chat_id === 42)?.state ===
        "admitted"
    );
    assertEquals(f.posts.length, 1);
  } finally {
    resume.resolve();
    old.lifetime.abort();
    next.lifetime.abort();
    await old.dispatcher.close();
    await next.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("idle fence retains an in-flight POST unchanged until the ordinary close join", async () => {
  const f = await world();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const post = f.client.session.promptAsync;
  f.client.session.promptAsync = async (value) => {
    const result = post(value);
    entered.resolve();
    await resume.promise;
    return await result;
  };
  const runtime = f.make(crypto.randomUUID());
  try {
    runtime.dispatcher.kick("session");
    await deadline(entered.promise);
    const d = f.registry.deliveries()[0];
    const before = f.registry.submissions(d.id);
    const now = Date.now();
    f.registry.write((tx) =>
      tx.acquireLease("session", runtime.holder, f.sub.owner_server, now)
    );
    runtime.dispatcher.fence();
    assertEquals(f.registry.submissions(d.id), before);
    assertEquals(
      f.registry.write((tx) =>
        tx.tryAcquireLease("session", "next", f.sub.owner_server, now)
      ),
      { acquired: false, retryAt: now + 90_000 },
    );
    let joined = false;
    const close = runtime.dispatcher.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    assertEquals(joined, false);
    runtime.lifetime.abort();
    resume.resolve();
    await deadline(close);
    assertEquals(f.posts.length, 1);
    assertEquals(
      f.registry.write((tx) =>
        tx.tryAcquireLease("session", "next", f.sub.owner_server, now)
      ),
      { acquired: true },
    );
  } finally {
    runtime.lifetime.abort();
    resume.resolve();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("idle fence releases answer-backed mirror while close still joins its pending outcome", async () => {
  const f = await world();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const runtime = f.make(crypto.randomUUID(), new Map(), async (d) => {
    f.registry.write((tx) =>
      tx.claimMirror(d.id, f.sub, "mirror-claim", "epoch", Date.now())
    );
    entered.resolve();
    await resume.promise;
    f.registry.write((tx) =>
      tx.finishMirror(d.id, "mirror-claim", "mirrored", Date.now(), [99])
    );
  });
  const d = f.registry.deliveries()[0];
  f.registry.write((tx) => {
    const s = tx.allocateSubmission(d.id, crypto.randomUUID(), 0, 3);
    tx.updateSubmission({ ...s, state: "admitted", updated_at: 4 });
    tx.recordAnswer(d.id, 0, {
      messageID: "msg_answer",
      partIDs: ["prt_answer"],
    }, 5);
    tx.acquireLease("session", runtime.holder, f.sub.owner_server, Date.now());
  });
  try {
    runtime.dispatcher.kick("session");
    await deadline(entered.promise);
    const before = f.registry.mirrorProgress(d.id);
    runtime.dispatcher.fence();
    assertEquals(
      f.registry.write((tx) =>
        tx.tryAcquireLease("session", "next", f.sub.owner_server, Date.now())
      ),
      { acquired: true },
    );
    assertEquals(f.registry.mirrorProgress(d.id), before);
    assertEquals(f.registry.deliveries()[0].state, "mirroring");
    let joined = false;
    const close = runtime.dispatcher.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    assertEquals(joined, false);
    resume.resolve();
    await deadline(close);
    assertEquals(f.registry.deliveries()[0].mirror_message_ids, [99]);
  } finally {
    resume.resolve();
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

Deno.test("paused native progress records a completed answer without relay I/O and releases the slot for another edge", async () => {
  const f = await world(),
    epoch = crypto.randomUUID(),
    d = f.registry.deliveries()[0];
  const submitted = f.registry.write((tx) => {
    const s = tx.allocateSubmission(d.id, epoch, 0, 3);
    tx.updateSubmission({ ...s, state: "admitted", updated_at: 4 });
    return s;
  });
  f.restoreRows([seed, {
    info: { id: submitted.message_id, role: "user", time: { created: 3 } },
    parts: [{
      id: submitted.part_id,
      type: "text",
      metadata: {
        deltaChatWake: {
          v: 1,
          deliveryId: d.id,
          relay: d.relay,
          chatId: 42,
          messageIds: [5],
        },
      },
    }],
  }, {
    info: {
      id: "msg_paused_answer",
      parentID: submitted.message_id,
      role: "assistant",
      finish: "stop",
      time: { created: 5, completed: 6 },
    },
    parts: [{
      id: "prt_paused_answer",
      type: "text",
      text: "completed before pause",
    }],
  }]);
  let pausedIO = 0, settled = 0;
  const disabled: DispatchRelay = {
    identity() {
      pausedIO++;
      throw new Error("paused I/O");
    },
    read() {
      pausedIO++;
      throw new Error("paused I/O");
    },
    call() {
      pausedIO++;
      throw new Error("paused I/O");
    },
    refreshNativeState: () => Promise.resolve(false),
  };
  const other: DispatchRelay = {
    identity: () => Promise.resolve(d.relay),
    refreshNativeState: () => Promise.resolve(true),
    read: () =>
      Promise.resolve({ messages: [{ ...message, id: 6, chatId: 43 }] }),
    call: () => Promise.resolve({ chats: [{ id: 43, name: "other room" }] }),
  };
  const runtime = f.make(
    epoch,
    new Map([["relay", disabled], ["other", other]]),
    () => Promise.resolve(),
    undefined,
    {
      enabled: (alias) => alias === "other",
      settled() {
        settled++;
      },
    },
  );
  try {
    runtime.dispatcher.kick("session");
    await poll(() =>
      f.registry.execution(d.id, 0)?.answerID === "msg_paused_answer"
    );
    assertEquals(f.posts, []);
    assertEquals(pausedIO, 0);
    assertEquals(settled > 0, true);
    f.registry.write((tx) => {
      const b = tx.subscribe({
        ...f.sub,
        alias: "other",
        chat_id: 43,
        message_id: 90,
      }, 8);
      tx.recordBatch(b, 90, [6], [6], 9);
      const paused = tx.subscribe({
        ...f.sub,
        alias: "relay",
        chat_id: 44,
        message_id: 90,
      }, 10);
      tx.recordBatch(paused, 90, [7], [7], 11);
    });
    runtime.dispatcher.kick("session");
    await poll(() => f.posts.length === 1);
    assertEquals(f.postedDeliveries, [
      f.registry.deliveries().find((x) => x.chat_id === 43)!.id,
    ]);
    assertEquals(
      f.registry.submissions(
        f.registry.deliveries().find((x) => x.chat_id === 44)!.id,
      ),
      [],
    );
    assertEquals(pausedIO, 0);
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});

const witnessedOld: OwnerWitness = {
  v: 1,
  bootID: "a".repeat(64),
  pidNS: "1:1",
  timeNS: "1:2",
  userNS: "1:3",
  uid: 1000,
  pid: 123,
  start: "456",
};
const witnessedNext: OwnerWitness = { ...witnessedOld, pid: 124, start: "789" };
Deno.test("proven dead owner port admits a ready delivery before unexpired lease deadline at the actual native submit consumer", async () => {
  const f = await world();
  f.registry.write((tx) =>
    tx.tryAcquireLease(
      "session",
      "dead",
      f.sub.owner_server,
      Date.now(),
      90000,
      { capture: () => witnessedOld, fate: () => "alive" },
    )
  );
  const runtime = f.make(crypto.randomUUID(), undefined, undefined, {
    capture: () => witnessedNext,
    fate: () => "dead",
  });
  try {
    f.setPositive();
    runtime.dispatcher.kick("session");
    await poll(() => f.posts.length === 1);
    const sub = f.registry.submissions(f.registry.deliveries()[0].id)[0];
    assertEquals(f.posts, [{ messageID: sub.message_id, partID: sub.part_id }]);
    assertEquals(sub.attempts, 1);
  } finally {
    runtime.lifetime.abort();
    await runtime.dispatcher.close();
    f.registry.close();
  }
});
Deno.test("dead-owner dispatcher recovery never replays a positively observed submitting/submitted/failed-admission/admitted original", async () => {
  for (
    const state of [
      "submitting",
      "submitted",
      "admission_failed",
      "admitted",
    ] as const
  ) {
    const f = await world(), d = f.registry.deliveries()[0];
    const original = f.registry.write((tx) => {
      const sub = tx.allocateSubmission(d.id, crypto.randomUUID(), 0, 3);
      if (state !== "submitting") {
        tx.updateSubmission({ ...sub, state, updated_at: 4 });
      }
      tx.observeNativeID(d.id, 0, 5);
      return sub;
    });
    f.registry.write((tx) =>
      tx.tryAcquireLease(
        "session",
        "dead",
        f.sub.owner_server,
        Date.now(),
        90000,
        { capture: () => witnessedOld, fate: () => "alive" },
      )
    );
    const runtime = f.make(crypto.randomUUID(), undefined, undefined, {
      capture: () => witnessedNext,
      fate: () => "dead",
    });
    try {
      runtime.dispatcher.kick("session");
      await poll(() => f.reads() > 0);
      await runtime.dispatcher.close();
      assertEquals(f.posts, []);
      const saved = f.registry.submissions(d.id)[0];
      assertEquals(saved.message_id, original.message_id);
      assertEquals(saved.part_id, original.part_id);
      assertEquals(saved.attempts, 1);
      assertEquals(f.registry.execution(d.id, 0)?.observedAt, 5);
    } finally {
      runtime.lifetime.abort();
      await runtime.dispatcher.close();
      f.registry.close();
    }
  }
});

Deno.test("idle fence cancels owned deadline and fallback timers without later reacquisition", async () => {
  for (const foreign of [false, true]) {
    const f = await world();
    f.nativeMode("busy");
    const runtime = f.make(crypto.randomUUID());
    const clock = controlledClock();
    try {
      if (foreign) {
        f.registry.write((tx) =>
          tx.acquireLease("session", "foreign", f.sub.owner_server, clock.now())
        );
      }
      runtime.dispatcher.kick("session");
      await clock.settle();
      assertEquals(clock.pending(), 1);
      runtime.dispatcher.fence();
      runtime.dispatcher.fence();
      assertEquals(clock.pending(), 0);
      const before = f.writes();
      runtime.dispatcher.kick("session");
      runtime.dispatcher.all();
      await clock.advance(300_000);
      assertEquals(f.writes(), before);
      assertEquals(f.posts, []);
      if (foreign) {
        assertEquals(
          f.registry.write((tx) =>
            tx.tryAcquireLease(
              "session",
              "next",
              f.sub.owner_server,
              clock.now() - 300_000,
            )
          ),
          { acquired: false, retryAt: clock.now() - 210_000 },
        );
      }
    } finally {
      runtime.lifetime.abort();
      await runtime.dispatcher.close();
      clock.restore();
      f.registry.close();
    }
  }
});
