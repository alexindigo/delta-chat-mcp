// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  root: "tests/fixtures/counter",
  plugins: [solid({ compiler: "native", hot: false })],
  build: { outDir: "../../../artifacts/m0/counter-dist", emptyOutDir: false },
});
