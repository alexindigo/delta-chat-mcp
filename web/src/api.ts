// SPDX-License-Identifier: LGPL-3.0-only
export type AccessMode = "public" | "password" | "totp";
export interface Session {
  setupRequired: boolean;
  mode: AccessMode | "";
  authenticated: boolean;
  username: string | null;
}
export interface Enrollment {
  key: string;
  uri: string;
  qr: string;
}
export interface KeyRow {
  id: string;
  name: string;
  created: number;
  lastUsed: number | null;
}
export interface NewKey {
  id: string;
  name: string;
  created: number;
  key: string;
}
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
export interface Api {
  session(): Promise<Session>;
  enroll(username: string): Promise<Enrollment>;
  setup(input: Record<string, string>): Promise<Session>;
  login(input: Record<string, string>): Promise<Session>;
  logout(): Promise<void>;
  keys(): Promise<{ keys: KeyRow[] }>;
  createKey(name: string): Promise<NewKey>;
  deleteKey(id: string): Promise<void>;
}
/** The only browser HTTP capability; all URLs are relative and cookies stay same-origin. */
export function browserApi(): Api {
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined
          ? {}
          : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ApiError(
        0,
        "Relay unreachable. Check the connection and try again.",
      );
    }
    if (!response.ok) {
      let message = "Request failed. Try again.";
      try {
        const value = await response.json();
        if (typeof value.error === "string") message = value.error;
      } catch { /* No raw HTML or stack traces in the view. */ }
      throw new ApiError(response.status, message);
    }
    return response.status === 204 ? undefined as T : await response.json();
  }
  return {
    session: () => request("/api/auth/session"),
    enroll: (username) => request("/api/auth/enroll", "POST", { username }),
    setup: (input) => request("/api/auth/setup", "POST", input),
    login: async (input) => {
      await request("/api/auth/login", "POST", input);
      return await request("/api/auth/session");
    },
    logout: () => request("/api/auth/logout", "POST"),
    keys: () => request("/api/keys"),
    createKey: (name) => request("/api/keys", "POST", { name }),
    deleteKey: (id) => request(`/api/keys/${encodeURIComponent(id)}`, "DELETE"),
  };
}
