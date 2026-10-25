// SPDX-License-Identifier: LGPL-3.0-only
import { parse, stringify } from "@std/toml";
import { join } from "@std/path";
import { type Config, loadConfig } from "../config.ts";
import type { Log } from "../log.ts";
import {
  hashPassword,
  hex,
  timingSafeEqual,
  verifyPassword,
} from "./password.ts";
import { acceptedStep, enrollment } from "./totp.ts";
import {
  cookieToken,
  issueSession,
  sessionCookie,
  verifySession,
} from "./session.ts";

type Settings = Config["auth"];
type Stored = Settings & {
  lasttotpstep: number;
  activepasswordhash: string;
  credentialstamp: string;
  activekeydigest: string;
};
const fields = [
  "type",
  "username",
  "password",
  "totpkey",
  "secretkey",
  "sessionexpirydays",
] as const;
const runtimeFields = [
  "lasttotpstep",
  "activepasswordhash",
  "credentialstamp",
  "activekeydigest",
];
const passwordHash = /^pbkdf2_sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/;
const digest = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const stamp = (settings: Settings) =>
  digest(
    JSON.stringify([
      settings.type,
      settings.username,
      settings.password,
      settings.totpkey,
    ]),
  );
async function storedRecord(
  baseline: Settings,
  active: Settings,
  step: number,
): Promise<Stored> {
  return {
    ...baseline,
    lasttotpstep: step,
    activepasswordhash: active.password,
    credentialstamp: await stamp(active),
    activekeydigest: await digest(active.secretkey),
  };
}
export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}
function readStored(dir: string): Stored | undefined {
  try {
    const data = parse(Deno.readTextFileSync(join(dir, "auth.toml")));
    for (const key of Object.keys(data)) {
      if (![...fields, ...runtimeFields].includes(key)) {
        throw new Error("Unknown auth state field");
      }
    }
    for (const field of fields) {
      if (
        field === "sessionexpirydays"
          ? !Number.isSafeInteger(data[field])
          : typeof data[field] !== "string"
      ) throw new Error("Invalid auth state field");
    }
    if (!Number.isSafeInteger(data.lasttotpstep)) {
      throw new Error("Invalid TOTP replay state");
    }
    if (
      typeof data.activepasswordhash !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(data.credentialstamp)) ||
      !/^[a-f0-9]{64}$/.test(String(data.activekeydigest))
    ) throw new Error("Invalid auth runtime state");
    if (
      (data.password && !passwordHash.test(String(data.password))) ||
      (data.activepasswordhash && !passwordHash.test(data.activepasswordhash))
    ) throw new Error("Auth state requires password hashes");
    return data as Stored;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}
/** One configuration owner still applies optional TOML and env over generated access state. */
export function loadRuntimeConfig(env: Record<string, string>) {
  const initial = loadConfig({ env });
  const stored = readStored(initial.data.dir);
  const authState = stored
    ? Object.fromEntries(fields.map((field) => [field, stored[field]]))
    : undefined;
  let secretPinned = false;
  const cfg = loadConfig({
    env,
    authState,
    onAuthSecretPinned: (pinned) => {
      secretPinned = pinned;
    },
  });
  return { cfg, secretPinned };
}
export interface SetupInput {
  type: string;
  username?: string;
  password?: string;
  totpkey?: string;
  code?: string;
}

export class AuthState {
  #settings: Settings;
  #lastStep: number;
  #stored?: Stored;
  #settingUp = false;
  #queue: Promise<void> = Promise.resolve();
  private constructor(
    private readonly dir: string,
    settings: Settings,
    lastStep: number,
    private readonly qr: (text: string) => Promise<string>,
    private readonly log: Log,
    private readonly now: () => number,
    readonly cookieName: string,
  ) {
    this.#settings = { ...settings };
    this.#lastStep = lastStep;
    this.#register();
  }
  static async open(
    cfg: Config,
    options: {
      qr: (text: string) => Promise<string>;
      log: Log;
      secretPinned?: boolean;
      now?: () => number;
    },
  ) {
    const previous = readStored(cfg.data.dir);
    const settings = {
      ...cfg.auth,
      username: cfg.auth.username.trim().toLowerCase(),
    };
    if (!["password", "totp"].includes(settings.type)) {
      settings.username = "";
      settings.password = "";
      settings.totpkey = "";
    }
    if (settings.type === "password" || settings.type === "totp") {
      if (!settings.username || !settings.password) {
        throw new Error("Authentication requires username and password");
      }
      if (settings.type === "totp" && !/^[A-Z2-7]+$/.test(settings.totpkey)) {
        throw new Error("TOTP requires a Base32 enrollment key");
      }
      if (!settings.password.startsWith("pbkdf2_sha256$")) {
        const supplied = settings.password;
        const candidates = previous
          ? [previous.activepasswordhash, previous.password]
          : [];
        let matched: string | undefined;
        for (const candidate of candidates) {
          if (candidate && await verifyPassword(supplied, candidate)) {
            matched = candidate;
            break;
          }
        }
        settings.password = matched ?? await hashPassword(supplied);
      }
      if (
        !/^pbkdf2_sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(
          settings.password,
        )
      ) throw new Error("Invalid stored password hash");
    }
    const changed = previous !== undefined &&
      await stamp(settings) !== previous.credentialstamp;
    if (
      changed && options.secretPinned &&
      await digest(settings.secretkey) === previous!.activekeydigest
    ) {
      throw new Error(
        "Credential changes require rotating the explicitly pinned signing key",
      );
    }
    if (!settings.secretkey || (changed && !options.secretPinned)) {
      settings.secretkey = hex(crypto.getRandomValues(new Uint8Array(32)));
    }
    if (settings.secretkey.length < 32) {
      throw new Error("Signing key must contain at least 32 characters");
    }
    const state = new AuthState(
      cfg.data.dir,
      settings,
      previous?.lasttotpstep ?? -1,
      options.qr,
      options.log,
      options.now ?? Date.now,
      `dcmcp_${cfg.listen.port}`,
    );
    // Effective file/env overrides are runtime inputs, not edits to the saved
    // operator credentials. Only automatically-owned signing state rotates.
    const baseline = previous
      ? Object.fromEntries(
        fields.map((field) => [field, previous[field]]),
      ) as unknown as Settings
      : { ...settings };
    if (!options.secretPinned) baseline.secretkey = settings.secretkey;
    state.#stored = await storedRecord(baseline, settings, state.#lastStep);
    if (settings.type || previous) {
      await state.#save(!previous);
      if (settings.type === "public") {
        options.log.event("warn", "public_access", { open: true });
      }
    }
    return state;
  }
  get setupRequired() {
    return this.#settings.type === "";
  }
  get mode() {
    return this.#settings.type;
  }
  get username() {
    return this.#settings.username;
  }
  #register() {
    this.log.registerSecrets([
      this.#settings.password,
      this.#settings.totpkey,
      this.#settings.secretkey,
    ]);
  }
  async #save(create: boolean, stored = this.#stored!) {
    await Deno.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await Deno.chmod(this.dir, 0o700);
    const stage = join(this.dir, `.auth-${crypto.randomUUID()}.toml`);
    const file = await Deno.open(stage, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      const bytes = new TextEncoder().encode(stringify(stored));
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = await file.write(bytes.subarray(offset));
          if (!count) throw new Error("Auth write made no progress");
          offset += count;
        }
        await file.sync();
      } finally {
        file.close();
      }
      if (create) await Deno.link(stage, join(this.dir, "auth.toml"));
      else await Deno.rename(stage, join(this.dir, "auth.toml"));
    } finally {
      try {
        await Deno.remove(stage);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          this.log.event("warn", "auth_stage_cleanup_failed");
        }
      }
    }
  }
  async setup(input: SetupInput): Promise<string | null> {
    if (!this.setupRequired || this.#settingUp) {
      throw new AuthError(409, "Already configured");
    }
    if (!["public", "password", "totp"].includes(input.type)) {
      throw new AuthError(400, "Invalid access mode");
    }
    if (
      input.type !== "public" && (!input.username?.trim() || !input.password)
    ) throw new AuthError(400, "Username and password required");
    if (input.type === "totp" && !/^[A-Z2-7]+$/.test(input.totpkey ?? "")) {
      throw new AuthError(400, "TOTP enrollment key required");
    }
    const setupStep = input.type === "totp"
      ? acceptedStep(input.code ?? "", input.totpkey!, this.now())
      : -1;
    if (setupStep === null) {
      throw new AuthError(400, "Confirm the enrollment code");
    }
    this.#settingUp = true;
    const before = this.#settings;
    try {
      const next = {
        type: input.type,
        username: input.type === "public"
          ? ""
          : input.username!.trim().toLowerCase(),
        password: input.type === "public"
          ? ""
          : await hashPassword(input.password!),
        totpkey: input.type === "totp" ? input.totpkey! : "",
        secretkey: hex(crypto.getRandomValues(new Uint8Array(32))),
        sessionexpirydays: before.sessionexpirydays,
      };
      const record = await storedRecord(next, next, setupStep);
      try {
        await this.#save(true, record);
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          throw new AuthError(409, "Already configured");
        }
        throw error;
      }
      this.#settings = next;
      this.#stored = record;
      this.#lastStep = setupStep;
      this.#register();
      if (this.mode === "public") {
        this.log.event("warn", "public_access", { open: true });
      }
      return this.mode === "public" ? null : await issueSession(
        this.username,
        next.secretkey,
        next.sessionexpirydays,
        this.now(),
      );
    } finally {
      this.#settingUp = false;
    }
  }
  async enroll(username: string) {
    if (!this.setupRequired || this.#settingUp) {
      throw new AuthError(409, "Already configured");
    }
    const result = enrollment(username.trim());
    return { ...result, qr: await this.qr(result.uri) };
  }
  async login(
    username: string,
    password: string,
    code = "",
  ): Promise<string | null> {
    if (this.setupRequired) throw new AuthError(503, "Setup required");
    if (this.mode === "public") return null;
    const previous = this.#queue;
    const release = Promise.withResolvers<void>();
    this.#queue = release.promise;
    await previous;
    try {
      const settings = this.#settings;
      const passwordOK = await verifyPassword(password, settings.password);
      if (
        !passwordOK ||
        !timingSafeEqual(username.trim().toLowerCase(), settings.username)
      ) throw new AuthError(401, "Incorrect credentials");
      if (settings.type === "totp") {
        const step = acceptedStep(code, settings.totpkey, this.now());
        if (step === null || step <= this.#lastStep) {
          throw new AuthError(401, "Incorrect credentials");
        }
        const record = { ...this.#stored!, lasttotpstep: step };
        await this.#save(false, record);
        this.#stored = record;
        this.#lastStep = step;
      }
      return await issueSession(
        settings.username,
        settings.secretkey,
        settings.sessionexpirydays,
        this.now(),
      );
    } finally {
      release.resolve();
    }
  }
  async authenticated(request: Request): Promise<boolean> {
    if (this.setupRequired) return false;
    if (this.mode === "public") return true;
    const token = cookieToken(request, this.cookieName);
    return token !== null &&
      await verifySession(
        token,
        this.username,
        this.#settings.secretkey,
        this.now(),
      );
  }
  cookie(token: string) {
    return sessionCookie(
      this.cookieName,
      token,
      this.#settings.sessionexpirydays,
    );
  }
  async session(request: Request) {
    return {
      setupRequired: this.setupRequired,
      mode: this.mode,
      authenticated: await this.authenticated(request),
      username: this.setupRequired ? null : this.username,
    };
  }
}
