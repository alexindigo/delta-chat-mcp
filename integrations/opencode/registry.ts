// SPDX-License-Identifier: LGPL-3.0-only
import { z } from "zod";
import { immediate, type Row, type Sqlite } from "./sqlite.ts";
import {
  type OwnerProcess,
  type OwnerWitness,
  parseOwnerWitness,
  sameOwnerScope,
} from "./owner-witness.ts";
import {
  type Delivery,
  delivery,
  type DeliveryEdge,
  deliveryEdge,
  type DeliveryState,
  isTerminalDelivery,
  type RelayScope,
  relayScope,
  type RoutingKey,
  routingKey,
  sameRelayScope,
  type Submission,
  submission,
  type Subscription,
  subscription,
  terminalDeliveryStates,
  validDeliveryTransition,
} from "./types.ts";

export const schemaVersion = 1;
export class RemoteClaimConflict extends Error {}
export type LeaseAcquisition =
  | { acquired: true }
  | { acquired: false; retryAt: number | null };

const sqlEnum = (values: readonly string[]) =>
  values.map((s) => `'${s}'`).join(",");
const terminals = sqlEnum(terminalDeliveryStates);
const keyValues = (key: RoutingKey) => [key.session_id, key.relay, key.chat_id];
const keyWhere = "session_id=? AND relay=? AND chat_id=?";
const decodeSubscription = (row: Row) =>
  subscription.parse({
    ...row,
    recent_ids: JSON.parse(String(row.recent_ids)),
  });
const decodeDelivery = (row: Row) =>
  delivery.parse({
    ...row,
    ...Object.fromEntries(
      ["message_ids", "model_sent_ids", "mirror_message_ids"].map((
        k,
      ) => [k, JSON.parse(String(row[k]))]),
    ),
  });

// Metadata only. There is no payload/blob/error-text column or second history.
const schema = `
CREATE TABLE schema_version (version INTEGER NOT NULL PRIMARY KEY CHECK(version=1));
INSERT INTO schema_version VALUES(1);
CREATE TABLE subscription (
 session_id TEXT NOT NULL, relay TEXT NOT NULL, chat_id INTEGER NOT NULL CHECK(chat_id>0),
 directory TEXT NOT NULL, owner_server TEXT NOT NULL, alias TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN (${
  sqlEnum(subscription.shape.state.options)
})),
 anchor_id INTEGER NOT NULL CHECK(anchor_id>0), recent_ids TEXT NOT NULL CHECK(json_valid(recent_ids)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, left_at INTEGER,
 PRIMARY KEY(session_id,relay,chat_id)
);
CREATE TABLE delivery (
 id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, relay TEXT NOT NULL, chat_id INTEGER NOT NULL,
 from_anchor INTEGER NOT NULL, message_ids TEXT NOT NULL CHECK(json_valid(message_ids)),
 state TEXT NOT NULL CHECK(state IN (${sqlEnum(delivery.shape.state.options)})),
 user_message_id TEXT, attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
 continuations INTEGER NOT NULL CHECK(continuations BETWEEN 0 AND 2),
 model_sent_ids TEXT NOT NULL CHECK(json_valid(model_sent_ids)),
 mirror_message_ids TEXT NOT NULL CHECK(json_valid(mirror_message_ids)),
 superseding_message_id TEXT, reason TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
 CHECK((state IN (${terminals})) = (completed_at IS NOT NULL)),
 FOREIGN KEY(session_id,relay,chat_id) REFERENCES subscription(session_id,relay,chat_id)
);
CREATE INDEX delivery_queue ON delivery(session_id,created_at,id);
CREATE UNIQUE INDEX delivery_open ON delivery(session_id,relay,chat_id) WHERE state='open';
CREATE TABLE submission (
 delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2), kind TEXT NOT NULL CHECK(kind IN ('initial','continuation')),
 message_id TEXT NOT NULL UNIQUE, part_id TEXT NOT NULL UNIQUE, submit_epoch TEXT NOT NULL,
 attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),
 state TEXT NOT NULL CHECK(state IN ('submitting','submitted','admitted','admission_failed','failed')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK((ordinal=0) = (kind='initial')), PRIMARY KEY(delivery_id,ordinal)
);
CREATE TABLE lease (
 session_id TEXT PRIMARY KEY NOT NULL, holder TEXT NOT NULL, owner_server TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE VIEW keeper_directories AS
 SELECT owner_server,directory FROM subscription WHERE state NOT IN ('left','orphaned')
 UNION SELECT s.owner_server,s.directory FROM delivery d JOIN subscription s
 ON s.session_id=d.session_id AND s.relay=d.relay AND s.chat_id=d.chat_id
 WHERE d.state NOT IN (${terminals});
`;

let lastTimestamp = 0;
let counter = 0;
/** Pinned schema/identifier.ts ascending layout (12 hex + 14 base62). */
export function nativeID(
  prefix: "msg" | "prt",
  timestamp = Date.now(),
): string {
  const now = Math.max(timestamp, lastTimestamp);
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  }
  if (++counter >= 0x1000) {
    lastTimestamp++;
    counter = 1;
  }
  const value = BigInt(lastTimestamp) * 0x1000n + BigInt(counter);
  const time = Array.from(
    { length: 6 },
    (_, i) =>
      Number((value >> BigInt(40 - 8 * i)) & 255n).toString(16).padStart(
        2,
        "0",
      ),
  ).join("");
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `${prefix}_${time}${
    Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => chars[b % 62])
      .join("")
  }`;
}

export class Registry {
  constructor(private readonly db: Sqlite) {
    immediate(db, () => {
      const exists = db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
      );
      if (!exists) db.exec(schema);
      else {
        const rows = db.all("SELECT version FROM schema_version");
        if (rows.length !== 1 || rows[0].version !== schemaVersion) {
          throw new Error("Unsupported registry schema");
        }
      }
      // Additive v1 routing extension: old keeper readers still select the same
      // authoritative view. No new delivery phase or transport acknowledgement.
      db.exec(`CREATE TABLE IF NOT EXISTS native_execution (
        delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, boundary_id TEXT, answer_id TEXT,
        answer_part_ids TEXT NOT NULL DEFAULT '[]', finished_at INTEGER,
        id_observed_at INTEGER,
        PRIMARY KEY(delivery_id,ordinal),
        FOREIGN KEY(delivery_id,ordinal) REFERENCES submission(delivery_id,ordinal)
      )`);
      if (
        !db.all("PRAGMA table_info(native_execution)").some((r) =>
          r.name === "id_observed_at"
        )
      ) {
        db.exec(
          "ALTER TABLE native_execution ADD COLUMN id_observed_at INTEGER",
        );
      }
      db.exec(`CREATE TABLE IF NOT EXISTS mirror_progress (
        delivery_id TEXT PRIMARY KEY REFERENCES delivery(id) ON DELETE CASCADE,
        claim TEXT, epoch TEXT NOT NULL, attempts INTEGER NOT NULL,
        retry_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_send (
        delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE CASCADE,
        native_message_id TEXT NOT NULL, native_part_id TEXT NOT NULL,
        call_id TEXT NOT NULL, core_id INTEGER NOT NULL CHECK(core_id>0),
        fingerprint TEXT NOT NULL,
        PRIMARY KEY(delivery_id,native_message_id,native_part_id,call_id,core_id)
      )`);
      // Already fully admitted rows are positive native-ID observations too.
      db.exec(`CREATE TABLE IF NOT EXISTS remote_binding (
        session_id TEXT NOT NULL, alias TEXT NOT NULL, relay TEXT NOT NULL,
        owner_server TEXT NOT NULL, directory TEXT NOT NULL,
        PRIMARY KEY(session_id,alias)
      );
      CREATE TABLE IF NOT EXISTS remote_claim (
        delivery_id TEXT PRIMARY KEY, claimant TEXT NOT NULL, claim_token TEXT,
        completed INTEGER NOT NULL DEFAULT 0
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS lease_witness (
        holder TEXT PRIMARY KEY NOT NULL,v INTEGER NOT NULL CHECK(v=1),
        boot_id TEXT NOT NULL,pid_ns TEXT NOT NULL,time_ns TEXT NOT NULL,
        user_ns TEXT NOT NULL,uid INTEGER NOT NULL CHECK(uid>=0),
        pid INTEGER NOT NULL CHECK(pid>0),start TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS delivery_edge (
        delivery_id TEXT PRIMARY KEY REFERENCES remote_claim(delivery_id),
        identity TEXT NOT NULL,inbox_uri TEXT NOT NULL,alias TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS model_send_attempt (
        id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE CASCADE,
        native_message_id TEXT NOT NULL,native_part_id TEXT NOT NULL,call_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','uncertain','sent','not_dispatched')),
        core_id INTEGER CHECK(core_id>0)
      )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS model_send_attempt_delivery ON model_send_attempt(delivery_id)",
      );
      if (
        !db.all("PRAGMA table_info(remote_binding)").some((r) =>
          r.name === "inbox_uri"
        )
      ) {
        db.exec("ALTER TABLE remote_binding ADD COLUMN inbox_uri TEXT");
      }
      if (
        !db.all("PRAGMA table_info(remote_claim)").some((r) =>
          r.name === "completed_at"
        )
      ) {
        db.exec("ALTER TABLE remote_claim ADD COLUMN completed_at INTEGER");
      }
      db.exec(
        `UPDATE native_execution SET id_observed_at=(SELECT updated_at FROM submission s WHERE s.delivery_id=native_execution.delivery_id AND s.ordinal=native_execution.ordinal)
        WHERE id_observed_at IS NULL AND EXISTS(SELECT 1 FROM submission s WHERE s.delivery_id=native_execution.delivery_id AND s.ordinal=native_execution.ordinal AND s.state='admitted')`,
      );
    });
  }

  // Transaction-scoped facade permits atomic anchor/delivery and submission/state
  // commits; callers never receive a raw database or an async transaction.
  write<T>(run: (tx: RegistryWriter) => T): T {
    return immediate(this.db, () => {
      const tx = new RegistryWriter(this.db);
      try {
        return run(tx);
      } finally {
        tx.finish();
      }
    });
  }
  subscriptions(session?: string): Subscription[] {
    return this.db.all(
      `SELECT * FROM subscription${
        session ? " WHERE session_id=?" : ""
      } ORDER BY created_at,session_id,relay,chat_id`,
      ...(session ? [session] : []),
    ).map(decodeSubscription);
  }
  deliveries(session?: string): Delivery[] {
    return this.db.all(
      `SELECT * FROM delivery${
        session ? " WHERE session_id=?" : ""
      } ORDER BY created_at,id`,
      ...(session ? [session] : []),
    ).map(decodeDelivery);
  }
  submissions(id: string): Submission[] {
    return this.db.all(
      "SELECT * FROM submission WHERE delivery_id=? ORDER BY ordinal",
      id,
    ).map((r) => submission.parse(r));
  }
  execution(id: string, ordinal: number) {
    const row = this.db.get(
      "SELECT * FROM native_execution WHERE delivery_id=? AND ordinal=?",
      id,
      ordinal,
    );
    return row
      ? {
        boundaryID: row.boundary_id as string | null,
        answerID: row.answer_id as string | null,
        partIDs: JSON.parse(String(row.answer_part_ids)) as string[],
        finishedAt: row.finished_at as number | null,
        observedAt: row.id_observed_at as number | null,
      }
      : undefined;
  }
  mirrorProgress(id: string) {
    const row = this.db.get(
      "SELECT * FROM mirror_progress WHERE delivery_id=?",
      id,
    );
    return row
      ? {
        claim: row.claim as string | null,
        epoch: String(row.epoch),
        attempts: Number(row.attempts),
        retryAt: Number(row.retry_at),
      }
      : undefined;
  }
  modelSends(id: string) {
    return this.db.all("SELECT * FROM model_send WHERE delivery_id=?", id).map((
      r,
    ) => ({
      messageID: String(r.native_message_id),
      partID: String(r.native_part_id),
      callID: String(r.call_id),
      coreID: Number(r.core_id),
      fingerprint: String(r.fingerprint),
    }));
  }
  modelAttempts(id: string) {
    return this.db.all(
      "SELECT * FROM model_send_attempt WHERE delivery_id=?",
      id,
    ).map((r) => ({
      id: String(r.id),
      messageID: String(r.native_message_id),
      partID: String(r.native_part_id),
      callID: String(r.call_id),
      fingerprint: String(r.fingerprint),
      status: String(r.status),
      coreID: r.core_id === null ? null : Number(r.core_id),
    }));
  }
  beginModelAttempt(
    id: string,
    evidence: {
      messageID: string;
      partID: string;
      callID: string;
      fingerprint: string;
    },
  ) {
    z.string().regex(/^[0-9a-f]{64}$/).parse(evidence.fingerprint);
    return immediate(this.db, () => {
      const d = this.db.get("SELECT state FROM delivery WHERE id=?", id);
      if (
        !d || !["admitted", "submitted", "submitting"].includes(String(d.state))
      ) throw new Error("Native send binding no longer active");
      const attempt = crypto.randomUUID();
      this.db.run(
        "INSERT INTO model_send_attempt VALUES(?,?,?,?,?,?,?,NULL)",
        attempt,
        id,
        evidence.messageID,
        evidence.partID,
        evidence.callID,
        evidence.fingerprint,
        "pending",
      );
      return attempt;
    });
  }
  finishModelAttempt(
    attempt: string,
    status: "uncertain" | "sent" | "not_dispatched",
    coreID?: number,
    chatID?: number,
  ) {
    if (status === "sent") z.number().int().positive().parse(coreID);
    if (
      status === "sent" &&
      this.db.get(
          "SELECT d.chat_id FROM delivery d JOIN model_send_attempt a ON a.delivery_id=d.id WHERE a.id=?",
          attempt,
        )?.chat_id !== chatID
    ) {
      status = "uncertain";
      coreID = undefined;
    }
    this.db.run(
      "UPDATE model_send_attempt SET status=?,core_id=? WHERE id=? AND status='pending'",
      status,
      coreID ?? null,
      attempt,
    );
  }
  /** Local bindings/progress only. The relay alone decides subscriptions and
   * recipient order; no local interest timestamp or recipient is stored. */
  bindRemote(
    session: string,
    alias: string,
    relay: string,
    owner: string,
    directory: string,
    scope?: RelayScope,
  ) {
    if (scope) relayScope.parse(scope);
    if (scope && scope.identity !== relay) {
      throw new Error("Binding identity changed");
    }
    this.db.run(
      `INSERT INTO remote_binding(session_id,alias,relay,owner_server,directory,inbox_uri) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,alias)
      DO UPDATE SET relay=excluded.relay,owner_server=excluded.owner_server,directory=excluded.directory,inbox_uri=excluded.inbox_uri`,
      session,
      alias,
      relay,
      owner,
      directory,
      scope?.uri ?? null,
    );
  }
  remoteBindings() {
    return this.db.all("SELECT * FROM remote_binding").map((r) => ({
      session: String(r.session_id),
      alias: String(r.alias),
      relay: String(r.relay),
      owner: String(r.owner_server),
      directory: String(r.directory),
      uri: r.inbox_uri === null ? null : String(r.inbox_uri),
    }));
  }
  deliveryEdge(id: string): DeliveryEdge | undefined {
    const row = this.db.get(
      "SELECT * FROM delivery_edge WHERE delivery_id=?",
      id,
    );
    if (!row) return;
    const parsed = deliveryEdge.safeParse({
      identity: row.identity,
      uri: row.inbox_uri,
      alias: row.alias,
    });
    return parsed.success ? parsed.data : undefined;
  }
  prepareRemoteClaim(id: string, edge?: DeliveryEdge): string {
    return immediate(this.db, () => {
      const existing = this.remoteClaim(id), bound = this.deliveryEdge(id);
      if (edge) {
        deliveryEdge.parse(edge);
        if (
          (existing?.token ||
            this.db.get("SELECT id FROM delivery WHERE id=?", id)) &&
          (!bound || !sameRelayScope(edge, bound))
        ) {
          throw new RemoteClaimConflict(
            "Remote claim authorization scope unavailable or changed",
          );
        }
      }
      this.db.run(
        "INSERT OR IGNORE INTO remote_claim(delivery_id,claimant) VALUES(?,?)",
        id,
        crypto.randomUUID(),
      );
      // A durable claimant permits recovery after response loss. A prepared
      // intent is NOT authorization: only import of a positive grant freezes it.
      return String(
        this.db.get(
          "SELECT claimant FROM remote_claim WHERE delivery_id=?",
          id,
        )!
          .claimant,
      );
    });
  }
  remoteClaim(id: string) {
    const r = this.db.get("SELECT * FROM remote_claim WHERE delivery_id=?", id);
    return r
      ? {
        claimant: String(r.claimant),
        token: r.claim_token === null ? null : String(r.claim_token),
        completed: r.completed === 1,
      }
      : undefined;
  }
  /** Claim token + immutable local batch commit before any native admission. */
  importRemote(input: {
    id: string;
    session: string;
    alias: string;
    relay: string;
    chat: number;
    anchor: number | null;
    ids: number[];
    token: string;
    claimant: string;
    owner: string;
    directory: string;
    edge?: DeliveryEdge;
  }) {
    this.write((tx) => {
      const edge = this.deliveryEdge(input.id);
      const claim = this.remoteClaim(input.id);
      if (
        claim?.token &&
        (input.edge
          ? !edge || !sameRelayScope(edge, input.edge) ||
            input.relay !== edge.identity
          : edge !== undefined)
      ) {
        throw new RemoteClaimConflict(
          "Remote claim authorization scope changed",
        );
      }
      if (input.edge) {
        deliveryEdge.parse(input.edge);
        if (input.relay !== input.edge.identity) {
          throw new Error("Claim identity changed");
        }
      }
      if (
        !claim || claim.claimant !== input.claimant ||
        (claim.token && claim.token !== input.token)
      ) throw new RemoteClaimConflict("Remote claim conflict");
      this.db.run(
        "UPDATE remote_claim SET claim_token=? WHERE delivery_id=?",
        input.token,
        input.id,
      );
      const prior = this.deliveries().find((d) => d.id === input.id);
      if (prior) {
        const binding = tx.subscription(prior);
        if (
          prior.session_id !== input.session ||
          prior.relay !== input.relay || prior.chat_id !== input.chat ||
          prior.from_anchor !== (input.anchor ?? input.ids[0]) ||
          binding?.owner_server !== input.owner ||
          binding?.directory !== input.directory ||
          JSON.stringify(prior.message_ids) !== JSON.stringify(input.ids)
        ) throw new RemoteClaimConflict("Frozen remote batch changed");
        return;
      }
      if (!claim.token && input.edge) {
        this.db.run(
          `INSERT INTO delivery_edge VALUES(?,?,?,?) ON CONFLICT(delivery_id)
           DO UPDATE SET identity=excluded.identity,inbox_uri=excluded.inbox_uri,alias=excluded.alias`,
          input.id,
          input.edge.identity,
          input.edge.uri,
          input.edge.alias,
        );
      }
      const s = tx.subscribe({
        session_id: input.session,
        alias: input.alias,
        relay: input.relay,
        chat_id: input.chat,
        message_id: input.anchor ?? input.ids[0],
        owner_server: input.owner,
        directory: input.directory,
      }, Date.now());
      tx.putDelivery({
        id: input.id,
        session_id: input.session,
        relay: input.relay,
        chat_id: input.chat,
        from_anchor: input.anchor ?? input.ids[0],
        message_ids: input.ids,
        state: "open",
        user_message_id: null,
        attempts: 0,
        continuations: 0,
        model_sent_ids: [],
        mirror_message_ids: [],
        superseding_message_id: null,
        reason: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      });
      // A retained historical local left/orphaned row is not routing authority.
      tx.putSubscription({ ...s, state: "active" });
    });
  }
  completeRemote(id: string, now = Date.now()) {
    this.db.run(
      "UPDATE remote_claim SET completed=1,completed_at=COALESCE(completed_at,?) WHERE delivery_id=?",
      now,
      id,
    );
  }
  directories(owner: string): string[] {
    return this.db.all(
      "SELECT directory FROM keeper_directories WHERE owner_server=? ORDER BY directory",
      owner,
    ).map((r) => z.string().parse(r.directory));
  }
  close() {
    this.db.close();
  }
  get runtime() {
    return this.db.runtime;
  }
}

export class RegistryWriter {
  #active = true;
  constructor(private readonly db: Sqlite) {}
  finish() {
    this.#active = false;
  }
  #check() {
    if (!this.#active) throw new Error("Expired registry transaction");
  }
  /** A successful send is evidence that this session now belongs to this
   * server/directory. Transfer all live routing atomically, never another session.
   * Historical rows with no in-flight work retain their original ownership. */
  subscribe(input: {
    session_id: string;
    relay: string;
    chat_id: number;
    message_id: number;
    directory: string;
    owner_server: string;
    alias: string;
  }, now: number): Subscription {
    this.#check();
    const prior = this.subscription(input);
    this.db.run(
      `UPDATE subscription SET owner_server=?,directory=?,updated_at=? WHERE session_id=? AND
       (state NOT IN ('left','orphaned') OR EXISTS
        (SELECT 1 FROM delivery d WHERE d.session_id=subscription.session_id AND d.relay=subscription.relay AND d.chat_id=subscription.chat_id AND d.state NOT IN (${terminals})))`,
      input.owner_server,
      input.directory,
      now,
      input.session_id,
    );
    // A lease granted by the former owner must not block the legitimate owner.
    this.db.run(
      "DELETE FROM lease WHERE session_id=? AND owner_server<>?",
      input.session_id,
      input.owner_server,
    );
    this.#pruneWitnesses();
    const fresh = !prior || prior.state === "left" ||
      prior.state === "orphaned";
    const row: Subscription = {
      session_id: input.session_id,
      relay: input.relay,
      chat_id: input.chat_id,
      directory: input.directory,
      owner_server: input.owner_server,
      alias: input.alias,
      // Sending cannot silently clear a known discontinuity.
      state: prior?.state === "blocked_discontinuity" ? prior.state : "active",
      anchor_id: fresh ? input.message_id : prior.anchor_id,
      recent_ids: fresh ? [input.message_id] : prior.recent_ids,
      created_at: prior?.created_at ?? now,
      updated_at: now,
      left_at: null,
    };
    this.putSubscription(row);
    return row;
  }
  leave(key: RoutingKey, now: number): Subscription {
    this.#check();
    const row = this.subscription(key);
    if (!row) throw new Error("Subscription not found");
    const left: Subscription = {
      ...row,
      state: "left",
      updated_at: now,
      left_at: row.left_at ?? now,
    };
    this.putSubscription(left);
    // Only unsubmitted work can be cancelled without an admission lookup. A
    // submitted original may still persist (C21). The future dispatcher owns
    // positive-ID reconciliation and completion of those in-flight submissions.
    this.db.run(
      `UPDATE delivery SET state='cancelled',reason='left',updated_at=?,completed_at=? WHERE ${keyWhere} AND state='open'`,
      now,
      now,
      ...keyValues(key),
    );
    return left;
  }
  resume(key: RoutingKey, after: number, now: number): Subscription {
    this.#check();
    const row = this.subscription(key);
    if (!row || row.state !== "blocked_discontinuity") {
      throw new Error("Subscription is not blocked");
    }
    const resumed: Subscription = {
      ...row,
      state: "active",
      anchor_id: after,
      recent_ids: [after],
      updated_at: now,
    };
    this.putSubscription(resumed);
    return resumed;
  }
  putSubscription(input: Subscription): void {
    this.#check();
    const row = subscription.strict().parse(input);
    const values = { ...row, recent_ids: JSON.stringify(row.recent_ids) };
    const keys = Object.keys(values);
    this.db.run(
      `INSERT INTO subscription (${keys.join(",")}) VALUES (${
        keys.map(() => "?").join(",")
      }) ON CONFLICT(session_id,relay,chat_id) DO UPDATE SET ${
        keys.filter((k) =>
          !["session_id", "relay", "chat_id", "created_at"].includes(k)
        ).map((k) => `${k}=excluded.${k}`).join(",")
      }`,
      ...Object.values(values),
    );
  }
  putDelivery(input: Delivery): void {
    this.#check();
    const row = delivery.strict().parse(input);
    if (isTerminalDelivery(row.state) !== (row.completed_at !== null)) {
      throw new Error("Invalid completion timestamp");
    }
    const prior = this.db.get("SELECT * FROM delivery WHERE id=?", row.id);
    if (prior) {
      const before = decodeDelivery(prior);
      if (!validDeliveryTransition(before.state, row.state)) {
        throw new Error("Invalid delivery transition");
      }
      for (
        const k of [
          "session_id",
          "relay",
          "chat_id",
          "from_anchor",
          "created_at",
        ] as const
      ) {
        if (before[k] !== row[k]) {
          throw new Error("Delivery routing is immutable");
        }
      }
    }
    const values = {
      ...row,
      message_ids: JSON.stringify(row.message_ids),
      model_sent_ids: JSON.stringify(row.model_sent_ids),
      mirror_message_ids: JSON.stringify(row.mirror_message_ids),
    };
    const keys = Object.keys(values);
    this.db.run(
      `INSERT INTO delivery (${keys.join(",")}) VALUES (${
        keys.map(() => "?").join(",")
      }) ON CONFLICT(id) DO UPDATE SET ${
        keys.filter((k) => k !== "id").map((k) => `${k}=excluded.${k}`).join(
          ",",
        )
      }`,
      ...Object.values(values),
    );
  }
  transition(
    id: string,
    expected: DeliveryState,
    state: DeliveryState,
    now: number,
    reason: Delivery["reason"] = null,
    superseding: string | null = null,
  ): void {
    this.#check();
    const row = this.db.get("SELECT * FROM delivery WHERE id=?", id);
    if (!row || row.state !== expected) {
      throw new Error("Delivery state conflict");
    }
    this.putDelivery({
      ...decodeDelivery(row),
      state,
      reason,
      superseding_message_id: superseding,
      updated_at: now,
      completed_at: isTerminalDelivery(state) ? now : null,
    });
  }
  allocateSubmission(
    id: string,
    epoch: string,
    ordinal: number,
    now: number,
    boundaryID: string | null = null,
  ): Submission {
    this.#check();
    const previous = this.db.get(
      "SELECT * FROM submission WHERE delivery_id=? AND ordinal=?",
      id,
      ordinal,
    );
    if (previous) return submission.parse(previous);
    const parent = this.db.get("SELECT * FROM delivery WHERE id=?", id);
    if (!parent) throw new Error("Missing delivery");
    const d = decodeDelivery(parent);
    const priorOrdinal = this.db.get(
      "SELECT MAX(ordinal) AS ordinal FROM submission WHERE delivery_id=?",
      id,
    )?.ordinal;
    if (
      isTerminalDelivery(d.state) || ordinal > 2 ||
      ordinal !== (priorOrdinal === null ? 0 : Number(priorOrdinal) + 1) ||
      (ordinal > 0 && d.state !== "admitted")
    ) throw new Error("Invalid submission ordinal");
    const row = submission.parse({
      delivery_id: id,
      ordinal,
      kind: ordinal === 0 ? "initial" : "continuation",
      message_id: nativeID("msg", now),
      part_id: nativeID("prt", now),
      submit_epoch: epoch,
      attempts: 1,
      state: "submitting",
      created_at: now,
      updated_at: now,
    });
    const keys = Object.keys(row);
    this.db.run(
      `INSERT INTO submission (${keys.join(",")}) VALUES (${
        keys.map(() => "?").join(",")
      })`,
      ...Object.values(row),
    );
    this.db.run(
      "INSERT INTO native_execution(delivery_id,ordinal,boundary_id) VALUES(?,?,?)",
      id,
      ordinal,
      boundaryID,
    );
    this.putDelivery({
      ...d,
      state: "submitting",
      attempts: 1,
      continuations: ordinal,
      updated_at: now,
    });
    return row;
  }
  recordAnswer(
    id: string,
    ordinal: number,
    answer: { messageID: string; partIDs: string[] },
    now: number,
  ) {
    this.#check();
    z.string().min(1).parse(answer.messageID);
    z.array(z.string().min(1)).parse(answer.partIDs);
    this.db.run(
      "UPDATE native_execution SET answer_id=?,answer_part_ids=?,finished_at=? WHERE delivery_id=? AND ordinal=? AND answer_id IS NULL",
      answer.messageID,
      JSON.stringify(answer.partIDs),
      now,
      id,
      ordinal,
    );
  }
  /** Compare-and-claim across all plugin connections. Commit before outbound I/O. */
  claimMirror(
    id: string,
    binding: Subscription,
    token: string,
    epoch: string,
    now: number,
    fingerprint?: string,
  ): boolean {
    this.#check();
    const raw = this.db.get("SELECT * FROM delivery WHERE id=?", id);
    if (!raw || raw.state !== "admitted") return false;
    if (
      fingerprint &&
      this.db.get(
        "SELECT id FROM model_send_attempt WHERE delivery_id=? AND fingerprint=? AND status<>'not_dispatched' LIMIT 1",
        id,
        fingerprint,
      )
    ) return false;
    const d = decodeDelivery(raw), s = this.subscription(d);
    const progress = this.db.get(
      "SELECT * FROM mirror_progress WHERE delivery_id=?",
      id,
    );
    if (
      !s || s.alias !== binding.alias ||
      s.owner_server !== binding.owner_server ||
      s.directory !== binding.directory || s.state === "paused" ||
      s.state === "unroutable" ||
      (progress &&
        (Number(progress.attempts) >= 3 || Number(progress.retry_at) > now))
    ) return false;
    if (
      !this.db.get(
        "SELECT answer_id FROM native_execution WHERE delivery_id=? AND ordinal=?",
        id,
        d.continuations,
      )?.answer_id
    ) return false;
    this.db.run(
      `INSERT INTO mirror_progress VALUES(?,?,?,1,0)
      ON CONFLICT(delivery_id) DO UPDATE SET claim=excluded.claim,epoch=excluded.epoch,attempts=mirror_progress.attempts+1,retry_at=0`,
      id,
      token,
      epoch,
    );
    this.transition(id, "admitted", "mirroring", now);
    return true;
  }
  finishMirror(
    id: string,
    token: string | null,
    state:
      | "mirrored"
      | "mirror_uncertain"
      | "mirror_failed"
      | "answered_by_model"
      | "empty",
    now: number,
    coreIDs: number[] = [],
  ): boolean {
    this.#check();
    const raw = this.db.get("SELECT * FROM delivery WHERE id=?", id);
    if (!raw) return false;
    const d = decodeDelivery(raw);
    if (token !== null) {
      if (
        d.state !== "mirroring" ||
        this.db.get("SELECT claim FROM mirror_progress WHERE delivery_id=?", id)
            ?.claim !== token
      ) return false;
    } else if (
      d.state !== "admitted" &&
      !(d.state === "mirroring" && state === "mirror_uncertain")
    ) return false;
    this.putDelivery({
      ...d,
      state,
      updated_at: now,
      completed_at: now,
      reason: state === "mirror_uncertain"
        ? "transport_uncertain"
        : state === "mirror_failed"
        ? "relay_error"
        : null,
      mirror_message_ids: state === "mirrored" ? coreIDs : d.mirror_message_ids,
      model_sent_ids: state === "answered_by_model"
        ? coreIDs
        : d.model_sent_ids,
    });
    return true;
  }
  deferMirror(
    id: string,
    token: string,
    now: number,
    retryAt: number,
    paused: boolean,
  ): boolean {
    this.#check();
    if (
      this.db.get("SELECT claim FROM mirror_progress WHERE delivery_id=?", id)
        ?.claim !== token
    ) return false;
    const raw = this.db.get("SELECT * FROM delivery WHERE id=?", id);
    if (!raw || raw.state !== "mirroring") return false;
    this.db.run(
      "UPDATE mirror_progress SET claim=NULL,retry_at=?,attempts=attempts-? WHERE delivery_id=?",
      retryAt,
      paused ? 1 : 0,
      id,
    );
    this.transition(id, "mirroring", "admitted", now);
    return true;
  }
  recordModelSend(
    id: string,
    evidence: {
      messageID: string;
      partID: string;
      callID: string;
      coreID: number;
      fingerprint: string;
    },
  ) {
    this.#check();
    const raw = this.db.get("SELECT * FROM delivery WHERE id=?", id);
    if (
      !raw ||
      !["admitted", "submitted", "submitting"].includes(String(raw.state))
    ) return;
    z.number().int().positive().parse(evidence.coreID);
    z.string().regex(/^[0-9a-f]{64}$/).parse(evidence.fingerprint);
    this.db.run(
      "INSERT OR IGNORE INTO model_send VALUES(?,?,?,?,?,?)",
      id,
      evidence.messageID,
      evidence.partID,
      evidence.callID,
      evidence.coreID,
      evidence.fingerprint,
    );
  }
  /** Positive existence is irreversible, independently of part confirmation.
   * Local deletion and a new epoch never turn an observed ID into replay rights. */
  observeNativeID(id: string, ordinal: number, now: number) {
    this.#check();
    this.db.run(
      "UPDATE native_execution SET id_observed_at=COALESCE(id_observed_at,?) WHERE delivery_id=? AND ordinal=?",
      now,
      id,
      ordinal,
    );
    this.db.run(
      "UPDATE delivery SET user_message_id=(SELECT message_id FROM submission WHERE delivery_id=? AND ordinal=?) WHERE id=?",
      id,
      ordinal,
      id,
    );
  }
  /** The anchor and every human ID it passes commit together. Core IDs are
   * positions, never counters; duplicate retained suffixes are replay skips. */
  recordBatch(
    key: Subscription,
    anchor: number,
    ids: number[],
    humans: number[],
    now: number,
  ): boolean {
    this.#check();
    // Structural callers may supply a full Subscription; persistence owns the
    // projection to a routing key, so subscription columns cannot leak into a
    // strict delivery record.
    const routing = routingKey.parse(key);
    const row = this.subscription(routing);
    if (
      !row || row.state !== "active" || row.anchor_id !== anchor ||
      !ids.length ||
      row.alias !== key.alias || row.owner_server !== key.owner_server ||
      row.directory !== key.directory
    ) return false;
    const fresh = ids.filter((id) => !row.recent_ids.includes(id));
    const humanIDs = humans.filter((id) => fresh.includes(id));
    if (humanIDs.length) {
      const raw = this.db.get(
        `SELECT * FROM delivery WHERE ${keyWhere} AND state='open'`,
        ...keyValues(key),
      );
      const prior = raw ? decodeDelivery(raw) : undefined;
      this.putDelivery(
        prior
          ? {
            ...prior,
            message_ids: [...new Set([...prior.message_ids, ...humanIDs])],
            updated_at: now,
          }
          : {
            id: crypto.randomUUID(),
            ...routing,
            from_anchor: anchor,
            message_ids: humanIDs,
            state: "open",
            user_message_id: null,
            attempts: 0,
            continuations: 0,
            model_sent_ids: [],
            mirror_message_ids: [],
            superseding_message_id: null,
            reason: null,
            created_at: now,
            updated_at: now,
            completed_at: null,
          },
      );
    }
    this.putSubscription({
      ...row,
      anchor_id: ids.at(-1)!,
      recent_ids: [...row.recent_ids, ...fresh].slice(-32),
      updated_at: now,
    });
    return true;
  }
  updateSubmission(input: Submission): void {
    this.#check();
    const row = submission.strict().parse(input);
    const prior = this.db.get(
      "SELECT * FROM submission WHERE delivery_id=? AND ordinal=?",
      row.delivery_id,
      row.ordinal,
    );
    if (!prior) throw new Error("Missing submission");
    for (const k of ["message_id", "part_id", "created_at", "kind"]) {
      if (prior[k] !== row[k as keyof Submission]) {
        throw new Error("Submission identity is immutable");
      }
    }
    const retry = row.attempts !== prior.attempts;
    if (
      retry && this.db.get(
          "SELECT id_observed_at FROM native_execution WHERE delivery_id=? AND ordinal=?",
          row.delivery_id,
          row.ordinal,
        )?.id_observed_at != null
    ) {
      throw new Error("Observed native identity cannot be resubmitted");
    }
    if (
      retry &&
      (row.attempts !== Number(prior.attempts) + 1 ||
        row.submit_epoch === prior.submit_epoch || row.state !== "submitting" ||
        prior.state === "admitted")
    ) throw new Error("Invalid submission retry");
    if (!retry && row.submit_epoch !== prior.submit_epoch) {
      throw new Error("Epoch changes only on retry");
    }
    const allowed: Record<Submission["state"], readonly Submission["state"][]> =
      {
        submitting: [
          "submitting",
          "submitted",
          "admitted",
          "admission_failed",
          "failed",
        ],
        submitted: [
          "submitting",
          "submitted",
          "admitted",
          "admission_failed",
          "failed",
        ],
        admission_failed: [
          "submitting",
          "admitted",
          "admission_failed",
          "failed",
        ],
        admitted: ["admitted"],
        failed: [],
      };
    if (
      !allowed[submission.parse(prior).state].includes(row.state) ||
      (row.state === "submitting" && prior.state !== "submitting" && !retry)
    ) throw new Error("Invalid submission transition");
    this.db.run(
      "UPDATE submission SET submit_epoch=?,attempts=?,state=?,updated_at=? WHERE delivery_id=? AND ordinal=?",
      row.submit_epoch,
      row.attempts,
      row.state,
      row.updated_at,
      row.delivery_id,
      row.ordinal,
    );
    const parent = this.db.get(
      "SELECT * FROM delivery WHERE id=?",
      row.delivery_id,
    );
    if (!parent) throw new Error("Missing delivery");
    const d = decodeDelivery(parent);
    if (d.continuations !== row.ordinal) {
      throw new Error("Cannot update an earlier submission");
    }
    this.putDelivery({
      ...d,
      state: row.state,
      attempts: row.attempts,
      user_message_id: row.state === "admitted"
        ? row.message_id
        : d.user_message_id,
      updated_at: row.updated_at,
      completed_at: row.state === "failed" ? row.updated_at : null,
    });
  }
  acquireLease(
    session: string,
    holder: string,
    owner: string,
    now: number,
    ttl = 90_000,
  ): boolean {
    return this.tryAcquireLease(session, holder, owner, now, ttl).acquired;
  }
  /** Deadline evidence belongs to this same transaction, not a caller's clock
   * guess or a separate read of a possibly renewed/reassigned lease. */
  tryAcquireLease(
    session: string,
    holder: string,
    owner: string,
    now: number,
    ttl = 90_000,
    process?: OwnerProcess,
  ): LeaseAcquisition {
    this.#check();
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new Error("Invalid lease TTL");
    }
    const rows = this.db.all(
      `SELECT DISTINCT s.owner_server FROM subscription s WHERE s.session_id=? AND
       (s.state NOT IN ('left','orphaned') OR EXISTS
        (SELECT 1 FROM delivery d WHERE d.session_id=s.session_id AND d.relay=s.relay AND d.chat_id=s.chat_id AND d.state NOT IN (${terminals})))`,
      session,
    );
    if (!rows.length || rows.some((r) => r.owner_server !== owner)) {
      return { acquired: false, retryAt: null };
    }
    let witness: OwnerWitness | undefined;
    try {
      witness = parseOwnerWitness(process?.capture());
    } catch { /* ordinary unwitnessed lease */ }
    const prior = this.db.get(
      "SELECT * FROM lease WHERE session_id=?",
      session,
    );
    const ownWitness = this.db.get(
      "SELECT * FROM lease_witness WHERE holder=?",
      holder,
    );
    // An unavailable current profile cannot renew a prior witness as fresh truth.
    // Keep its historical lease/metadata untouched rather than pruning a reference.
    if (!witness && ownWitness) {
      return {
        acquired: false,
        retryAt: prior ? Number(prior.expires_at) : null,
      };
    }
    if (
      prior && Number(prior.expires_at) > now &&
      (prior.owner_server !== owner || prior.holder !== holder)
    ) {
      const oldRow = this.db.get(
        "SELECT * FROM lease_witness WHERE holder=?",
        String(prior.holder),
      );
      const old = this.#decodeWitness(oldRow);
      let dead = false;
      if (
        prior.owner_server === owner && prior.holder !== holder && witness &&
        old && sameOwnerScope(witness, old)
      ) {
        try {
          dead = process?.fate(old) === "dead";
        } catch { /* unknown keeps the lease */ }
      }
      if (!dead) return { acquired: false, retryAt: Number(prior.expires_at) };
      // BEGIN IMMEDIATE owns this comparison and the irreversible death proof.
      // Also retain the exact row/witness comparison across the injected probe.
      const current = this.db.get(
        "SELECT * FROM lease WHERE session_id=?",
        session,
      );
      const currentWitness = this.db.get(
        "SELECT * FROM lease_witness WHERE holder=?",
        String(prior.holder),
      );
      if (
        JSON.stringify(current) !== JSON.stringify(prior) ||
        JSON.stringify(currentWitness) !== JSON.stringify(oldRow)
      ) throw new Error("Lease witness changed during probe");
      this.db.run(
        "DELETE FROM lease WHERE session_id=? AND holder=? AND owner_server=? AND expires_at=?",
        session,
        String(prior.holder),
        owner,
        Number(prior.expires_at),
      );
    }
    this.db.run(
      "INSERT INTO lease VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET holder=excluded.holder,owner_server=excluded.owner_server,expires_at=excluded.expires_at",
      session,
      holder,
      owner,
      now + ttl,
    );
    if (witness) {
      this.db.run(
        "INSERT INTO lease_witness VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(holder) DO NOTHING",
        holder,
        witness.v,
        witness.bootID,
        witness.pidNS,
        witness.timeNS,
        witness.userNS,
        witness.uid,
        witness.pid,
        witness.start,
      );
      const stored = this.#decodeWitness(
        this.db.get("SELECT * FROM lease_witness WHERE holder=?", holder),
      );
      if (JSON.stringify(stored) !== JSON.stringify(witness)) {
        throw new Error("Lease witness conflict");
      }
    }
    this.#pruneWitnesses();
    return { acquired: true };
  }
  #decodeWitness(row: Row | undefined): OwnerWitness | undefined {
    if (!row) return;
    return parseOwnerWitness({
      v: row.v,
      bootID: row.boot_id,
      pidNS: row.pid_ns,
      timeNS: row.time_ns,
      userNS: row.user_ns,
      uid: row.uid,
      pid: row.pid,
      start: row.start,
    });
  }
  #pruneWitnesses() {
    this.db.run(
      "DELETE FROM lease_witness WHERE NOT EXISTS (SELECT 1 FROM lease WHERE lease.holder=lease_witness.holder)",
    );
  }
  releaseLease(session: string, holder: string): void {
    this.#check();
    this.db.run(
      "DELETE FROM lease WHERE session_id=? AND holder=?",
      session,
      holder,
    );
    this.#pruneWitnesses();
  }
  /** Only a fenced holder may hand off idle sessions before its async joins.
   * Inspect every room/owner in the session, not just currently eligible work. */
  releaseIdleLeases(holder: string): string[] {
    this.#check();
    const sessions = this.db.all(
      `SELECT l.session_id FROM lease l WHERE l.holder=? AND NOT EXISTS (
        SELECT 1 FROM delivery d WHERE d.session_id=l.session_id
        AND d.state NOT IN (${terminals}) AND NOT (
          (d.state='open' AND NOT EXISTS (
            SELECT 1 FROM submission s WHERE s.delivery_id=d.id
          )) OR (d.state IN ('admitted','mirroring') AND EXISTS (
            SELECT 1 FROM submission s WHERE s.delivery_id=d.id
            AND s.ordinal=d.continuations AND s.state='admitted'
            AND s.ordinal=(SELECT MAX(latest.ordinal) FROM submission latest WHERE latest.delivery_id=d.id)
            AND EXISTS (SELECT 1 FROM native_execution e WHERE e.delivery_id=d.id
              AND e.ordinal=s.ordinal AND e.answer_id IS NOT NULL)
          ))
        )
      ) ORDER BY l.session_id`,
      holder,
    ).map((row) => z.string().parse(row.session_id));
    for (const session of sessions) this.releaseLease(session, holder);
    return sessions;
  }
  prune(now: number): void {
    this.#check();
    this.db.run(
      `DELETE FROM delivery WHERE state IN (${terminals}) AND completed_at<?
       AND NOT EXISTS(SELECT 1 FROM remote_claim c WHERE c.delivery_id=delivery.id AND c.completed<>1)`,
      now - 7 * 86400_000,
    );
    // Only durably acknowledged, aged and now orphaned claims are disposable.
    // A token-null intent can represent a lost accepted claim response forever.
    const safe =
      `SELECT delivery_id FROM remote_claim WHERE completed=1 AND completed_at<? AND NOT EXISTS(SELECT 1 FROM delivery WHERE id=delivery_id)`;
    this.db.run(
      `DELETE FROM delivery_edge WHERE delivery_id IN (${safe})`,
      now - 7 * 86400_000,
    );
    this.db.run(
      `DELETE FROM remote_claim WHERE delivery_id IN (${safe})`,
      now - 7 * 86400_000,
    );
  }
  subscription(key: RoutingKey): Subscription | undefined {
    this.#check();
    routingKey.parse(key);
    const row = this.db.get(
      `SELECT * FROM subscription WHERE ${keyWhere}`,
      ...keyValues(key),
    );
    return row ? decodeSubscription(row) : undefined;
  }
}
