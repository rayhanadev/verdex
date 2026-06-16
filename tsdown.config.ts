import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: {
    eager: true,
  },
  sourcemap: true,
  clean: true,
});
