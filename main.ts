// SPDX-License-Identifier: LGPL-3.0-only

import { loadRuntimeConfig } from "./src/auth/state.ts";
import { startService } from "./src/service.ts";
import { createLog } from "./src/log.ts";

if (import.meta.main) {
  try {
    const { cfg, secretPinned } = loadRuntimeConfig(Deno.env.toObject());
    const service = await startService(cfg, { signals: true, secretPinned });
    await service.finished;
  } catch (error) {
    createLog("error").event("error", "startup_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    Deno.exitCode = 1;
  }
}
