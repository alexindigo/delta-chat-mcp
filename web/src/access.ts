// SPDX-License-Identifier: LGPL-3.0-only
import type { AccessMode, Api, Enrollment, Session } from "./api.ts";
export interface AccessState {
  session: Session | null;
  loading: boolean;
  busy: boolean;
  error: string;
  mode: AccessMode;
  username: string;
  password: string;
  code: string;
  enrollment: Enrollment | null;
  qrUrl: string;
}
export const initialAccess = (): AccessState => ({
  session: null,
  loading: true,
  busy: false,
  error: "",
  mode: "password",
  username: "",
  password: "",
  code: "",
  enrollment: null,
  qrUrl: "",
});
export class Access {
  state = initialAccess();
  #generation = 0;
  constructor(
    private api: Api,
    private publish: (state: AccessState) => void,
    private onSession: (session: Session) => void,
  ) {}
  private patch(patch: Partial<AccessState>) {
    this.state = { ...this.state, ...patch };
    this.publish(this.state);
  }
  field(name: "username" | "password" | "code", value: string) {
    this.patch({ [name]: value });
  }
  choose(mode: AccessMode) {
    this.patch({ mode, error: "", enrollment: null, qrUrl: "", code: "" });
  }
  private accept(session: Session) {
    this.patch({
      session,
      loading: false,
      password: "",
      code: "",
      enrollment: null,
      qrUrl: "",
      error: "",
    });
    this.onSession(session);
  }
  async refresh() {
    if (this.state.busy) return;
    const generation = ++this.#generation;
    try {
      const session = await this.api.session();
      if (generation === this.#generation) this.accept(session);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.patch({
        loading: false,
        error: error instanceof Error
          ? error.message
          : "Unable to load access.",
      });
    }
  }
  private async run(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.patch({ busy: true, error: "" });
    try {
      await action();
    } catch (error) {
      this.patch({
        error: error instanceof Error
          ? error.message
          : "Access request failed. Try again.",
      });
    } finally {
      this.patch({ busy: false });
    }
  }
  enroll() {
    return this.run(async () => {
      const enrollment = await this.api.enroll(this.state.username);
      this.patch({
        enrollment,
        qrUrl: `data:image/svg+xml,${encodeURIComponent(enrollment.qr)}`,
      });
    });
  }
  submit() {
    return this.run(async () => {
      this.#generation++;
      const input = this.state;
      const session = input.session?.setupRequired
        ? await this.api.setup({
          type: input.mode,
          username: input.username,
          password: input.password,
          ...(input.mode === "totp"
            ? { totpkey: input.enrollment?.key ?? "", code: input.code }
            : {}),
        })
        : await this.api.login({
          username: input.username,
          password: input.password,
          code: input.code,
        });
      this.accept(session);
    });
  }
  logout() {
    return this.run(async () => {
      this.#generation++;
      await this.api.logout();
      this.accept(await this.api.session());
    });
  }
}
