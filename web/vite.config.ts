// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [solid({ compiler: "native", hot: false })],
  build: { outDir: "dist" },
});
