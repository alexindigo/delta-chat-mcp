// SPDX-License-Identifier: LGPL-3.0-only
import type { CoreClient, CoreRpc } from "../../src/core/client.ts";
import { CoreUnavailable } from "../../src/core/client.ts";

/** Unimplemented operations fail rather than giving tests plausible empty results. */
export class FakeCore implements CoreClient {
  available = true;
  calls: { method: string; args: unknown[] }[] = [];
  constructor(readonly handlers: Partial<CoreRpc>) {}
  async use<T>(call: (rpc: CoreRpc) => Promise<T>): Promise<T> {
    if (!this.available) throw new CoreUnavailable();
    const rpc = new Proxy({} as CoreRpc, {
      get: (_target, method: string) => (...args: unknown[]) => {
        this.calls.push({ method, args });
        const fn = this.handlers[method as keyof CoreRpc];
        if (!fn) throw new Error(`Unimplemented fake core call: ${method}`);
        return Reflect.apply(fn, this.handlers, args);
      },
    });
    return await call(rpc);
  }
}
