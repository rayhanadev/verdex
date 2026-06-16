# @rayhanadev/verdex

## 0.1.0

Initial public release — a small, type-safe, OPA-inspired policy engine for TypeScript with zero runtime dependencies.

### Features

- **Typed rule registry with end-to-end inference.** Rules are TypeScript functions; `engine.authz.allow({ input })` and `ctx.authz.isAdmin(user)` are fully-typed proxy queries/calls that autocomplete package/rule paths and error on typos. String forms (`engine.query`, `ctx.call`) remain as escape hatches.
- **OPA-style rule kinds** — `complete`, `set` (partial set), `object` (partial object), `func`, plus `default`, and `when` / `contains` clause sugar. A `match()` helper for first-match-wins decisions.
- **Standard Schema validation** for `input`, `data`, and function args/output (Zod, Valibot, ArkType, Effect Schema). Synchronous only — async schemas throw `AsyncSchemaError`.
- **`Decision<T>`** discriminated result; query-scoped `with` overrides; typed `bundle()` factory.

### Safety & semantics

- **Prototype-pollution hardened.** `engine.put` / `Store.delete` / `merge` / `with`-override targets reject `__proto__` / `prototype` / `constructor`; reads only surface own properties.
- **Pure rules.** `ctx.input` and `ctx.data` are deep-frozen per query; `ctx.store` is a read-only `ReadonlyStore` facade (`get` / `version`) — a rule cannot mutate shared engine state. The full mutable `Store` stays on the engine (`engine.put` / `engine.store`).
- **Value-correct conflict/dedup.** Deep equality handles `Date` / `Map` / `Set` / `RegExp` / typed arrays and uses `Object.is` on primitives (compares own-enumerable string keys; JSON-shaped data assumed).
- **Unique package names per engine.** `Engine.add()` rejects duplicates with `DuplicatePackageError` (atomic — a rejected add leaves the engine usable). Cross-module same-package merging is out of scope for v0.1.
- **Reserved package roots** (`input`, `data`, `store`, `call`, `add`, `put`, `query`, `modules`, `constructor`) throw at `module()` instead of being silently shadowed by `ctx`/`engine` members.
- Engines/contexts are safe to `await`, `JSON.stringify`, and log.
