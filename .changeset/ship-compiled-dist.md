---
"@rayhanadev/verdex": minor
---

Ship a compiled `dist/` instead of raw TypeScript source. The package now publishes dual ESM + CommonJS builds (`dist/index.mjs` / `dist/index.cjs`) with type declarations and sourcemaps, and its `exports` map provides both `import` and `require` entry points. This means verdex now works out of the box in plain Node, any bundler, Deno, and Bun — no `.ts`-aware toolchain required (which `0.1.0`, shipping `.ts` source, needed).
