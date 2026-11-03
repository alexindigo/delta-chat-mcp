// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";

export interface RoomMember {
  namespace: string;
  session_id: string;
  interest: number;
  joined: boolean;
}
export interface RoutedRoom {
  chat_id: number;
  // Generation changes at interval start/end, independently of core IDs.
  interval: number;
  anchor_id: number | null;
  recent_ids: number[];
  state: "active" | "blocked_discontinuity";
  members: RoomMember[];
  recipient: string | null;
}
export interface InboxDelivery {
  delivery_id: string;
  namespace: string;
  target_session: string;
  chat_id: number;
  interval: number;
  from_anchor: number | null;
  message_ids: number[];
  state: "ready" | "claimed" | "completed";
  claimant: string | null;
  claim_token: string | null;
  outcome: string | null;
  mirror: "none" | "attempting" | "sent" | "uncertain";
  mirror_message_id: number | null;
  // Absent on legacy rows: unknown age is conservatively retained.
  completed_at?: number;
}
export interface RoutingMetadata {
  sequence: number;
  namespaces: { owner: string; id: string }[];
  rooms: RoutedRoom[];
  deliveries: InboxDelivery[];
  notices: {
    chat_id: number;
    recipient: string | null;
    state: "attempting" | "sent" | "uncertain";
    completed_at?: number;
  }[];
}
const empty = (): RoutingMetadata => ({
  sequence: 0,
  namespaces: [],
  rooms: [],
  deliveries: [],
  notices: [],
});

/** A synchronous SQLite transaction is the single routing/claim serialization
 * boundary. Async core I/O never holds the transaction. No body/text is stored. */
export class RoomRoutingStore {
  constructor(private readonly db: DatabaseSync) {}
  read(): RoutingMetadata {
    const raw = this.db.prepare("SELECT metadata FROM room_routing WHERE id=1")
      .get();
    return raw ? JSON.parse(String(raw.metadata)) as RoutingMetadata : empty();
  }
  write<T>(run: (state: RoutingMetadata) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = run(state);
      this.db.prepare(
        "INSERT INTO room_routing VALUES(1,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
      ).run(JSON.stringify(state));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
