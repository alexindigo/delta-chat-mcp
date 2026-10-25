// SPDX-License-Identifier: LGPL-3.0-only

import { loadConfig } from "./src/config.ts";
import { startService } from "./src/service.ts";
import { createLog } from "./src/log.ts";

if (import.meta.main) {
  try {
    const service = await startService(loadConfig(), { signals: true });
    await service.finished;
  } catch (error) {
    createLog("error").event("error", "startup_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    Deno.exitCode = 1;
  }
}
