# @rayhanadev/verdex

## 0.3.0

### Minor Changes

- [#3](https://github.com/rayhanadev/verdex/pull/3) [`b77a8b2`](https://github.com/rayhanadev/verdex/commit/b77a8b201cf32f57f5a03c326e6dbb5be346850e) Thanks [@rayhanadev](https://github.com/rayhanadev)! - verdex 0.3: safety fixes, immutable engines, non-throwing `evaluate()`, typed inputs, and `explain()`.

  **Security**

  - Close a prototype-key policy bypass in per-query snapshots. 0.2 copied an own `"__proto__"` key in `input` or `data` with plain assignment, which replaced the snapshot's prototype: `{"user":{"__proto__":{"role":"admin"}}}` made a rule reading `user.role` see `"admin"`. A query document (`input`, per-query `data`, a `with` value, a `withData` document) or an `object` rule result with an own `__proto__` / `prototype` / `constructor` key now fails with the new `UnsafeKeyError` (a `PolicyError`); `new Engine({ unsafeKeys: "drop" })` removes such keys instead. `put`, `merge` and bundle data now reject unsafe keys at any depth (`TypeError`, as for unsafe path segments).

  **Breaking changes**

  - Modules and engines are immutable (copy-on-write). Every builder call (`when`, `complete`, `default`, …) returns a new `Module`, and `engine.add()` returns a new `Engine`; the receiver is never changed. Chained code is unaffected; code that relied on mutation (`m.when(…)` / `engine.add(…)` as statements) must use the returned value. A derived engine gets its own copy of the store.
  - Query `input` is typed by the module's input schema (its input type). A wrong shape is a compile error, and `input` is required when the schema rejects `undefined`.
  - The store keeps deep-frozen copies: `put` copies (and freezes) the value, every write produces a new frozen document, and `store.get` / `store.document` return frozen values.
  - New reserved package roots: `evaluate`, `decide`, `explain`, `compile`, `withData`, `rules`, `fingerprint`.
  - Type-level: the registry is now a union of single-path entries (`RuleEntry`), and the empty registry is `never` instead of `{}`.

  **Features**

  - `engine.evaluate(path, opts)` and `engine.<pkg>.<rule>.evaluate(opts)` never throw for engine or rule failures: they return `{ ok: true, decision } | { ok: false, error }`. A non-policy throw from a rule body becomes an `EvaluationError` with the original `cause` and the `rulePath` / `clause` that threw it. A `rethrow` predicate (engine option or per call) lets chosen values, such as a host panic type, propagate unchanged.
  - `engine.decide(path, opts)` (and `.decide` on handles) returns `T` directly for rules that are always defined (a `default`, or a `set` / `object` rule); other rules are a compile error.
  - Per-query `data` (`engine.query(path, { input, data })`) and an immutable `engine.withData(doc)` view, so per-request facts never touch shared state.
  - Rule references inside rules: `ctx.<pkg>.<rule>()` returns another rule's value and `ctx.query(path)` its `Decision`, memoized per query, with `CycleError` for reference loops. Function calls are memoized per query by argument identity.
  - Explainability: clause ids (`.when(name, pred, value, { id })`, `.complete(name, fn, { id })`, …), `engine.explain(path, opts)` (per-clause matched/value, function calls and rule references, policy fingerprint, duration), `evaluate(path, { trace: true })`, and `engine.fingerprint()` — a stable, synchronous, browser-safe hash of the policy. The normal query path records nothing.
  - `engine.compile(path)` returns a direct callable (with `evaluate`, `explain`, `decide`) that skips path resolution and proxy hops.
  - `engine.rules()` lists every rule (`path`, `kind`, `hasDefault`, clause count and ids, `description`, `see`, `meta`, module info); modules accept `version`, `description`, `see` and `meta`, and builders accept per-rule metadata.
  - `snapshot(value)` returns a deep-frozen copy that queries reuse without copying; any deep-frozen input is used by reference.

  **Performance**

  - Data is validated and frozen once per document (store version or frozen document identity) instead of on every query: a 200-entry catalog in `data` drops from ~73 µs to ~0.5 µs per query.
  - Path resolution uses an index, proxy handles are cached, set results dedupe primitives with a native `Set` (1,000 members: ~2.4 ms → ~45 µs), and function contexts are reused within a query.
  - Flat registry types: an 80-module `bundle()` type-checks in ~0.12 s (was ~6.9 s) and 160 modules in ~0.3 s (was ~54 s). A new `typecheck:perf` CI step guards this.

## 0.2.0

### Minor Changes

- [#1](https://github.com/rayhanadev/verdex/pull/1) [`b37bfeb`](https://github.com/rayhanadev/verdex/commit/b37bfebea14989d5b733fcd8136e5b97ffd750ae) Thanks [@rayhanadev](https://github.com/rayhanadev)! - Ship a compiled `dist/` instead of raw TypeScript source. The package now publishes dual ESM + CommonJS builds (`dist/index.mjs` / `dist/index.cjs`) with type declarations and sourcemaps, and its `exports` map provides both `import` and `require` entry points. This means verdex now works out of the box in plain Node, any bundler, Deno, and Bun — no `.ts`-aware toolchain required (which `0.1.0`, shipping `.ts` source, needed).

## 0.1.0

Initial public release — a small, type-safe, OPA-inspired policy engine for TypeScript with zero runtime dependencies.

### Features

- **Typed rule registry with end-to-end inference.** Rules are TypeScript functions; `engine.authz.allow({ input })` and `ctx.authz.isAdmin(user)` are fully-typed proxy queries/calls that autocomplete package/rule paths and error on typos. String forms (`engine.query`, `ctx.call`) remain as escape hatches.
- **OPA-style rule kinds** — `complete`, `set` (partial set), `object` (partial object), `func`, plus `default`, and `when` / `contains` clause sugar. A `match()` helper for first-match-wins decisions.
- **Standard Schema validation** for `input`, `data`, and function args/output (Zod, Valibot, ArkType, Effect Schema). Synchronous only — async schemas throw `AsyncSchemaError`.
- **`Decision<T>`** discriminated result; query-scoped `with` overrides; typed `bundle()` factory.
- **Ships compiled ESM + CommonJS** (`dist/`) with type declarations and sourcemaps — works in Node, Bun, Deno, and any bundler with no build step on your end.

### Safety & semantics

- **Prototype-pollution hardened.** `engine.put` / `Store.delete` / `merge` / `with`-override targets reject `__proto__` / `prototype` / `constructor`; reads only surface own properties.
- **Pure rules.** `ctx.input` and `ctx.data` are deep-frozen per query; `ctx.store` is a read-only `ReadonlyStore` facade (`get` / `version`) — a rule cannot mutate shared engine state. The full mutable `Store` stays on the engine (`engine.put` / `engine.store`).
- **Value-correct conflict/dedup.** Deep equality handles `Date` / `Map` / `Set` / `RegExp` / typed arrays and uses `Object.is` on primitives (compares own-enumerable string keys; JSON-shaped data assumed).
- **Unique package names per engine.** `Engine.add()` rejects duplicates with `DuplicatePackageError` (atomic — a rejected add leaves the engine usable). Cross-module same-package merging is out of scope for v0.1.
- **Reserved package roots** (`input`, `data`, `store`, `call`, `add`, `put`, `query`, `modules`, `constructor`) throw at `module()` instead of being silently shadowed by `ctx`/`engine` members.
- Engines/contexts are safe to `await`, `JSON.stringify`, and log.
