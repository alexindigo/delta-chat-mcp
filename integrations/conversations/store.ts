// SPDX-License-Identifier: LGPL-3.0-only
import { createHash } from "node:crypto";
import {
  localOwnerProcess,
  type OwnerProcess,
} from "../opencode/owner-witness.ts";
import { immediate, type Sqlite } from "../opencode/sqlite.ts";
import { type RelayScope, sameRelayScope } from "../opencode/types.ts";
import type { RemoteClaim } from "../opencode/modern-relay.ts";

export type Outcome =
  | "answered_by_model"
  | "empty"
  | "failed"
  | "interrupted_unanswered"
  | "superseded_by_native_input"
  | "source_deleted"
  | "stalled";
export interface Delivery {
  id: string;
  claimant: string;
  alias: string | null;
  identity: string | null;
  uri: string | null;
  session: string | null;
  chat: number | null;
  token: string | null;
  ids: string;
  input: string | null;
  nonce: string | null;
  turn: string | null;
  state:
    | "intent"
    | "claimed"
    | "dispatching"
    | "observed"
    | "settled"
    | "completed";
  outcome: Outcome | null;
  epoch: string;
  updated: number;
}
export interface Send {
  id: string;
  fingerprint: string;
  delivery: string | null;
  state: "attempting" | "sent" | "uncertain" | "rejected";
  core_id: number | null;
  chat: number | null;
  core_state: string | null;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const scopeOf = (d: Delivery): RelayScope => {
  if (!d.identity || !d.uri) throw new Error("No positive claim scope");
  return { identity: d.identity, uri: d.uri };
};

/** The integration owns references and receipts, never routing or message bodies.
 * A single proved process owner prevents concurrent native admission on reload. */
export class Store {
  readonly epoch = crypto.randomUUID();
  #owned = false;
  constructor(readonly db: Sqlite, readonly namespace = "default") {
    db.exec(
      `CREATE TABLE IF NOT EXISTS channel_version(v INTEGER PRIMARY KEY CHECK(v=1));
      INSERT OR IGNORE INTO channel_version VALUES(1);
      CREATE TABLE IF NOT EXISTS channel_owner(namespace TEXT PRIMARY KEY,epoch TEXT NOT NULL,witness TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_binding(namespace TEXT NOT NULL,session TEXT NOT NULL,alias TEXT NOT NULL,identity TEXT NOT NULL,uri TEXT NOT NULL,
        PRIMARY KEY(namespace,session,alias,identity,uri));
      CREATE TABLE IF NOT EXISTS channel_delivery(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,claimant TEXT NOT NULL,alias TEXT,identity TEXT,uri TEXT,
        session TEXT,chat INTEGER,token TEXT,ids TEXT NOT NULL DEFAULT '[]',input TEXT,nonce TEXT,turn TEXT,
        state TEXT NOT NULL,outcome TEXT,epoch TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_send(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,fingerprint TEXT NOT NULL,delivery TEXT,state TEXT NOT NULL,
        core_id INTEGER,chat INTEGER,core_state TEXT,updated INTEGER NOT NULL);`,
    );
    if (db.get("SELECT v FROM channel_version")?.v !== 1) {
      throw new Error("Unsupported channel state");
    }
  }
  acquire(process: OwnerProcess = localOwnerProcess) {
    const witness = process.capture();
    if (!witness) throw new Error("Cannot establish channel process ownership");
    immediate(this.db, () => {
      const previous = this.db.get(
        "SELECT * FROM channel_owner WHERE namespace=?",
        this.namespace,
      );
      if (
        previous &&
        process.fate(JSON.parse(String(previous.witness))) !== "dead"
      ) {
        throw new Error("Channel state already owned or ownership unknown");
      }
      this.db.run(
        "INSERT OR REPLACE INTO channel_owner VALUES(?,?,?)",
        this.namespace,
        this.epoch,
        JSON.stringify(witness),
      );
      this.db.run(
        "UPDATE channel_send SET state='uncertain' WHERE namespace=? AND state='attempting'",
        this.namespace,
      );
    });
    this.#owned = true;
  }
  assertOwner() {
    if (
      !this.#owned ||
      this.db.get(
          "SELECT epoch FROM channel_owner WHERE namespace=?",
          this.namespace,
        )?.epoch !==
        this.epoch
    ) {
      throw new Error("Channel ownership lost");
    }
  }
  release() {
    this.assertOwner();
    this.db.run(
      "DELETE FROM channel_owner WHERE namespace=? AND epoch=?",
      this.namespace,
      this.epoch,
    );
    this.#owned = false;
  }
  bind(session: string, alias: string, scope: RelayScope) {
    this.assertOwner();
    this.db.run(
      "INSERT OR IGNORE INTO channel_binding VALUES(?,?,?,?,?)",
      this.namespace,
      session,
      alias,
      scope.identity,
      scope.uri,
    );
  }
  bound(session: string, scope: RelayScope) {
    return !!this.db.get(
      "SELECT 1 FROM channel_binding WHERE namespace=? AND session=? AND identity=? AND uri=?",
      this.namespace,
      session,
      scope.identity,
      scope.uri,
    );
  }
  sessions() {
    return this.db.all(
      "SELECT DISTINCT session FROM channel_binding WHERE namespace=?",
      this.namespace,
    ).map((
      r,
    ) => String(r.session));
  }
  delivery(id: string): Delivery | undefined {
    return this.db.get(
      "SELECT * FROM channel_delivery WHERE id=? AND namespace=?",
      id,
      this.namespace,
    ) as unknown as Delivery | undefined;
  }
  deliveries(): Delivery[] {
    return this.db.all(
      "SELECT * FROM channel_delivery WHERE namespace=? ORDER BY updated,id",
      this.namespace,
    ) as unknown as Delivery[];
  }
  pending(session: string) {
    return this.deliveries().find((r) =>
      r.session === session && !["settled", "completed"].includes(r.state)
    );
  }
  intent(id: string) {
    this.assertOwner();
    this.db.run(
      "INSERT OR IGNORE INTO channel_delivery(id,namespace,claimant,state,epoch,updated) VALUES(?,?,?,'intent',?,?)",
      id,
      this.namespace,
      crypto.randomUUID(),
      this.epoch,
      Date.now(),
    );
    return this.delivery(id)!;
  }
  claim(alias: string, scope: RelayScope, claim: RemoteClaim) {
    this.assertOwner();
    const old = this.delivery(claim.delivery_id);
    if (!old || old.claimant !== claim.claimant) {
      throw new Error("Claimant mismatch");
    }
    if (old.token) {
      if (
        !sameRelayScope(scopeOf(old), scope) ||
        old.token !== claim.claim_token ||
        old.session !== claim.target_session || old.chat !== claim.chat_id
      ) {
        throw new Error("Frozen claim changed");
      }
      return old;
    }
    this.db.run(
      `UPDATE channel_delivery SET alias=?,identity=?,uri=?,session=?,chat=?,token=?,ids=?,state='claimed',updated=? WHERE id=? AND namespace=? AND token IS NULL`,
      alias,
      scope.identity,
      scope.uri,
      claim.target_session,
      claim.chat_id,
      claim.claim_token,
      JSON.stringify(claim.message_ids),
      Date.now(),
      claim.delivery_id,
      this.namespace,
    );
    return this.delivery(claim.delivery_id)!;
  }
  prepare(id: string, input: string) {
    this.assertOwner();
    this.db.run(
      "UPDATE channel_delivery SET input=?,nonce=?,state='dispatching',epoch=?,updated=? WHERE id=? AND namespace=? AND state='claimed'",
      input,
      crypto.randomUUID(),
      this.epoch,
      Date.now(),
      id,
      this.namespace,
    );
    return this.delivery(id)!;
  }
  observe(id: string, session: string, input: string, turn = input) {
    this.assertOwner();
    this.db.run(
      "UPDATE channel_delivery SET turn=?,state='observed',updated=? WHERE id=? AND session=? AND input=? AND namespace=? AND state IN ('dispatching','observed')",
      turn,
      Date.now(),
      id,
      session,
      input,
      this.namespace,
    );
  }
  settle(id: string, outcome: Outcome) {
    this.assertOwner();
    this.db.run(
      "UPDATE channel_delivery SET state='settled',outcome=?,updated=? WHERE id=? AND namespace=? AND state IN ('claimed','dispatching','observed')",
      outcome,
      Date.now(),
      id,
      this.namespace,
    );
  }
  sentOutcome(id: string): Outcome {
    if (
      this.db.get(
        "SELECT 1 FROM channel_send WHERE delivery=? AND namespace=? AND state IN ('attempting','uncertain')",
        id,
        this.namespace,
      )
    ) return "stalled";
    return this.db.get(
        "SELECT 1 FROM channel_send WHERE delivery=? AND namespace=? AND state='sent' AND core_id IS NOT NULL",
        id,
        this.namespace,
      )
      ? "answered_by_model"
      : "empty";
  }
  finish(session: string, turn: string, reason: "finished" | Outcome) {
    const row = this.pending(session);
    if (row?.state === "observed" && row.turn === turn) {
      this.settle(
        row.id,
        reason === "finished" ? this.sentOutcome(row.id) : reason,
      );
    }
  }
  completed(id: string) {
    this.assertOwner();
    this.db.run(
      "UPDATE channel_delivery SET state='completed',updated=? WHERE id=? AND namespace=? AND state='settled'",
      Date.now(),
      id,
      this.namespace,
    );
    const cutoff = Date.now() - 7 * 86400000;
    this.db.run(
      "DELETE FROM channel_send WHERE namespace=? AND updated<? AND state IN ('sent','rejected') AND (delivery IS NULL OR delivery IN (SELECT id FROM channel_delivery WHERE state='completed' AND updated<?))",
      this.namespace,
      cutoff,
      cutoff,
    );
    this.db.run(
      "DELETE FROM channel_delivery WHERE namespace=? AND state='completed' AND updated<? AND id NOT IN (SELECT delivery FROM channel_send WHERE delivery IS NOT NULL)",
      this.namespace,
      cutoff,
    );
  }
  send(id: string): Send | undefined {
    return this.db.get(
      "SELECT * FROM channel_send WHERE id=? AND namespace=?",
      id,
      this.namespace,
    ) as unknown as Send | undefined;
  }
  prepareSend(id: string, fingerprint: string, delivery: string | null) {
    this.assertOwner();
    this.db.run(
      "INSERT INTO channel_send(id,namespace,fingerprint,delivery,state,updated) VALUES(?,?,?,?,'attempting',?)",
      id,
      this.namespace,
      fingerprint,
      delivery,
      Date.now(),
    );
  }
  finishSend(
    id: string,
    state: Send["state"],
    core?: { message_id: number; chat_id: number; state: string },
  ) {
    this.assertOwner();
    this.db.run(
      "UPDATE channel_send SET state=?,core_id=?,chat=?,core_state=?,updated=? WHERE id=? AND namespace=?",
      state,
      core?.message_id ?? null,
      core?.chat_id ?? null,
      core?.state ?? null,
      Date.now(),
      id,
      this.namespace,
    );
  }
}
