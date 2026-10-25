// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import { hex } from "./password.ts";
const encoder = new TextEncoder();
export async function keyDigest(key: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(key)));
}
export class ApiKeys {
  #revoked = new Set<(id: string) => void>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
    private readonly registerSecrets: (values: readonly string[]) => void =
      () => {},
  ) {}
  async create(name: string) {
    if (!name.trim()) throw new Error("Key name required");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = "dcm_" +
      btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
        "/",
        "_",
      ).replaceAll("=", "");
    const id = await keyDigest(key), created = this.now();
    this.db.prepare(
      "INSERT INTO api_keys (digest,name,created_at) VALUES (?,?,?)",
    ).run(id, name.trim(), created);
    this.registerSecrets([key]);
    return { id, name: name.trim(), created, key };
  }
  list() {
    return this.db.prepare(
      "SELECT digest AS id,name,created_at AS created,last_used_at AS lastUsed FROM api_keys ORDER BY created_at,digest",
    ).all();
  }
  async authenticate(request: Request): Promise<string | null> {
    const match = /^Bearer (dcm_[A-Za-z0-9_-]{43})$/i.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match) return null;
    const id = await keyDigest(match[1]);
    const result = this.db.prepare(
      "UPDATE api_keys SET last_used_at=? WHERE digest=? RETURNING digest",
    ).get(this.now(), id);
    if (result) this.registerSecrets([match[1]]);
    return result ? id : null;
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM api_keys WHERE digest=?").run(id);
    for (const listener of [...this.#revoked]) {
      try {
        listener(id);
      } catch { /* One consumer cannot prevent revocation. */ }
    }
  }
  subscribeRevoked(listener: (id: string) => void): () => void {
    this.#revoked.add(listener);
    return () => {
      this.#revoked.delete(listener);
    };
  }
}
