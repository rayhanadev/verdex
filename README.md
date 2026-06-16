# verdex

[![npm](https://img.shields.io/npm/v/@rayhanadev/verdex.svg)](https://www.npmjs.com/package/@rayhanadev/verdex)
[![CI](https://github.com/rayhanadev/verdex/actions/workflows/ci.yml/badge.svg)](https://github.com/rayhanadev/verdex/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/rayhanadev/verdex/branch/main/graph/badge.svg)](https://codecov.io/gh/rayhanadev/verdex)
[![license](https://img.shields.io/npm/l/@rayhanadev/verdex.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/@rayhanadev/verdex.svg)](https://www.typescriptlang.org/)

Type-safe verdicts for TypeScript. A small, TypeScript-native policy engine inspired by [Open Policy Agent](https://www.openpolicyagent.org/docs). Rules are written as TypeScript functions; input, data, and function signatures are typed and validated via [Standard Schema](https://standardschema.dev) (works with Zod, Valibot, ArkType, Effect Schema). Zero runtime dependencies.

The interesting bits:

- **Method-shaped queries and calls.** `engine.authz.allow({ input })` and `ctx.authz.isAdmin(user)` — typed proxies over the registry. Returns the right type, autocompletes nested package paths, errors on typos. Path strings (`engine.query("authz.allow", …)` and `ctx.call("authz.isAdmin", …)`) still work as escape hatches.
- **The Module/Engine types track every rule you add.** No `<T>` casts at query sites; the registry is built up through fluent generics.
- **No `if` ladders.** A `match()` helper for first-match-wins decisions, plus `m.when` / `m.contains` sugar for OPA-style multi-clause rules.

Runs on [Bun](https://bun.com). The package ships TypeScript source (`exports` points at `src/index.ts`), so consume it from Bun or any toolchain that resolves `.ts`.

## Install

```bash
bun add @rayhanadev/verdex
bun add zod   # or any Standard Schema validator (Valibot, ArkType, Effect Schema)
```

## Quick start

```ts
import { z } from "zod";
import { Engine, match, module } from "@rayhanadev/verdex";

const Input = z.object({
  user: z.object({ role: z.enum(["admin", "member", "guest"]), banned: z.boolean().optional() }),
  action: z.enum(["read", "write", "delete"]),
});

const authz = module("authz", { input: Input })
  .default("allow", false)
  .func("isAdmin", { args: [z.object({ role: z.string() })], output: z.boolean() },
    (_ctx, user) => user.role === "admin")
  .complete("allow", (ctx) =>
    match(ctx.input)
      .when((i) => i.user.banned === true, undefined)
      .when((i) => ctx.authz.isAdmin(i.user), true)               // ← typed proxy call
      .when((i) => i.user.role === "member" && i.action !== "delete", true)
      .when((i) => i.user.role === "guest" && i.action === "read", true)
      .otherwise(undefined),
  )
  .contains("deny", (ctx) => ctx.input.user.banned === true, "user is banned")
  .contains("deny", (ctx) => ctx.input.user.role === "guest" && ctx.input.action !== "read", "guests can only read");

const engine = new Engine().add(authz);

const d = engine.authz.allow({                                    // ← typed proxy query
  input: { user: { role: "member" }, action: "write" },
});
if (d.defined) console.log(d.result); // true — typed as boolean

// Typo? Compile error:
engine.authz.allwo({ input: /* … */ });
//           ~~~~~ Property 'allwo' does not exist on type '{ allow: ...; deny: ... }'
```

Run the demo from a clone of this repo: `bun run examples/authz.ts`.

## Two ways to call: proxy or string

Inside a rule body and at query sites, you can use either form interchangeably:

|                             | Proxy (preferred)                       | String (escape hatch)                            |
| --------------------------- | --------------------------------------- | ------------------------------------------------ |
| Call a function from a rule | `ctx.authz.isAdmin(user)`               | `ctx.call("authz.isAdmin", user)`                |
| Query a rule from outside   | `engine.authz.allow({ input })`         | `engine.query("authz.allow", { input })`         |
| Nested packages (`a.b.c`)   | `engine.policies.admission.deny({...})` | `engine.query("policies.admission.deny", {...})` |

The proxy form gives you autocomplete on package and rule names, errors on typos at any segment, and reads as plain method calls. The string form is useful for genuinely-dynamic paths and stays available at runtime.

### Reserved root segments

Because `ctx` and `engine` already have built-in members, the following package roots collide with the proxy and are **reserved**:

```
input, data, store, call    (ctx members)
add, put, query, store      (engine members; modules is internal)
modules                     (engine's internal field)
constructor                 (on both, via the prototype chain)
```

`module("input", …)` throws at construction with a clear "reserved" message — so you get an early error instead of a package that silently resolves to the engine member instead of routing through the proxy.

Inherited `Object.prototype` names (`hasOwnProperty`, `valueOf`, …) are **not** reserved: they aren't real `ctx`/`engine` members, so a package named `hasOwnProperty` stays reachable through the proxy (the proxy distinguishes real own members from inherited ones).

## Concepts

| OPA                               | This library                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Rego module                       | `Module<P, I, D, R>` (P = package, R = accumulated rule registry)                 |
| Package path (`a.b.c`)            | `Package` (dotted name)                                                           |
| `default allow := false`          | `module.default(name, value)`                                                     |
| Complete rule (`allow := …`)      | `module.complete(name, fn)` — also `module.when(name, pred)`                      |
| Partial set (`deny contains msg`) | `module.set(name, fn*)` — also `module.contains(name, pred, value)`               |
| Partial object (`apps[h] := app`) | `module.object(name, fn*)`                                                        |
| User function                     | `module.func(name, schemas?, fn)` (call via `ctx.call`)                           |
| `data` document                   | `engine.put(path, value)`                                                         |
| `input` document                  | per-query, validated against the module's schema                                  |
| `with input as …`                 | `engine.query(path, { with: [{ target, value }] })`                               |
| Bundle                            | `bundle({ modules, data })` (factory infers types) or `new Bundle(...)` (untyped) |

A query returns a discriminated `Decision<T>`:

```ts
type Decision<T> =
  | { readonly defined: true; readonly result: T }
  | { readonly defined: false; readonly result?: undefined };
```

Narrow with `if (d.defined) { … d.result … }`.

## API

```ts
// Factory — captures package name as a literal type so paths type-check.
function module<const P, I = unknown, D = unknown>(
  packageName: P,
  schemas?: { input?: StandardSchemaV1<unknown, I>; data?: StandardSchemaV1<unknown, D> },
): Module<P, I, D, {}>;

class Module<P, I, D, R> {
  default<N, V>(name: N, value: V): Module<P, I, D, R + { `${P}.${N}`: V }>;
  complete<N, X>(name: N, fn: (ctx) => X | undefined): Module<P, I, D, R + { `${P}.${N}`: X }>;
  set<N, X>(name: N, fn: (ctx) => Iterable<X>): Module<P, I, D, R + { `${P}.${N}`: X[] }>;
  object<N, V>(name: N, fn: (ctx) => Iterable<[string, V]>): Module<P, I, D, R + { `${P}.${N}`: { [k]: V } }>;
  func<N, Args, Out>(name, schemas: { args, output }, fn): Module<P, I, D, R + { `${P}.${N}`: (...Args) => Out }>;

  // Sugar: clauses that mirror OPA's `allow if {…}` / `deny contains "x" if {…}`.
  when<N>(name, pred): Module<P, I, D, R + { `${P}.${N}`: true }>;
  when<N, V>(name, pred, value: V): Module<P, I, D, R + { `${P}.${N}`: V }>;
  contains<N, V>(name, pred, value: V): Module<P, I, D, R + { `${P}.${N}`: V[] }>;
}

class Engine<R = {}> {
  add(m: Module<...>): Engine<R + module's R>;
  add(b: Bundle<...>): Engine<R + bundle's R>;
  put(path, value): this;
  query<P extends RuleKeys<R>>(path: P, opts?): Decision<R[P]>;
}

interface Context<I, D, R> {
  input: I;
  data: D;
  store: ReadonlyStore; // read-only view: get(path) + version (no mutation, no live document)
  call<P extends FuncKeys<R>>(path: P, ...args: ArgsOf<R[P]>): RetOf<R[P]>;
}

// A read-only view of the data document handed to rules as `ctx.store`.
interface ReadonlyStore {
  get(path: Path): unknown;
  readonly version: number;
}

// Factory for bundles that infers the registry from the modules tuple.
function bundle<const Mods>(init: { modules: Mods; data?: Record<string, unknown> }): Bundle<RegistryOf<Mods>>;

// First-match-wins matcher.
function match<TIn>(input: TIn): {
  when<TOut>(pred: (x: TIn) => boolean, value: TOut | ((x: TIn) => TOut)): /* same matcher */;
  otherwise<TOut>(fallback: TOut | ((x: TIn) => TOut)): TOut;
};
```

## Semantics

- **Multiple complete rules** with the same name must agree at runtime; different defined values throw `ConflictError`. Their TS types union.
- **`set` rules** union their yielded members (deduped by deep equality).
- **`object` rules** must agree on values for a given key; different values throw `ConflictError`.
- **Defaults** kick in only when _all_ complete rules return `undefined`.
- **`with`-overrides** are scoped to a single query and don't mutate originals.
- **`ctx.input` and `ctx.data` are deep-frozen** per query, so a rule body can't mutate the shared data document or the caller's input. Rules are meant to be pure functions of their context.
- **`ctx.store` is a read-only view** (`ReadonlyStore`: `get(path)` + `version`). It cannot mutate shared engine state — use `engine.put` / `engine.store` for writes. `ctx.store.get` does pollution-safe own-property path lookup; the full document is available frozen as `ctx.data`. (`ctx.store` and `engine.store` are now different objects: a frozen per-query facade vs the live mutable `Store`.)
- **Package names are unique per engine** — `Engine.add()` throws `DuplicatePackageError` on a duplicate (including a bundle member that collides with an already-registered package). Clauses for a rule combine only within a single `Module`; combining across same-named modules is intentionally out of scope for v0.1 and may relax to an OPA-style merge in a future minor.
- **Schemas are sync-only.** If a schema's `validate` returns a Promise, the engine throws `AsyncSchemaError`.
- **Deep equality (`set` dedup, `complete`/`object` conflict checks) compares own-enumerable _string_ keys only.** Symbol-keyed properties are ignored. This is intended for JSON-ish policy values; two objects differing only in a symbol key are treated as equal.
- **Freezing covers plain objects and arrays.** Exotic containers placed in `ctx.data` — a `Map`, `Set`, `Date`, typed array, or class instance — are frozen at the top level but their _contents_ stay mutable (`Object.freeze` doesn't reach inside a `Map`/`Set`). Keep policy data to JSON-shaped values for the immutability guarantee to hold all the way down.

## Security

The engine ingests untrusted data documents and string paths, so the data store is hardened against prototype pollution:

- `engine.put`, `store.delete`, bundle `data`, and `with`-override targets **reject** `__proto__`, `prototype`, and `constructor` path segments (throws `TypeError`) instead of writing through them.
- Reads (`store.get`) only surface **own** properties, never inherited ones.

A query like `engine.put("__proto__.role", "admin")` throws rather than poisoning `Object.prototype` or flipping a default-deny policy. Found a security issue? Please disclose it privately via the repository's security advisory page.

## Trade-offs of the typed-path design

- `Engine`/`Module` hover info gets long. Worth it for the inference.
- Modules built dynamically (in a loop, in a factory function) lose per-rule typing — they fall back to `Module<string, unknown, unknown, {}>` and the registry stays empty. Use the typed factory for static modules; cast for dynamic.
- The `Engine.query` and `ctx.call` typed overloads only accept paths in the registry. For genuinely-dynamic strings, cast to the escape hatch: `(engine.query as (p: string) => unknown)(somePath)`.

## Errors

- `ValidationError` — input, data, function args, or function output failed schema validation.
- `ConflictError` — two complete rules / two `object` entries disagree. The full conflicting values are on `.values`; the message only reports the path and count (so secrets don't leak into logs).
- `UnknownRuleError` — query path didn't resolve at runtime.
- `RuleKindMismatchError` — re-declaring a rule with a different kind, or duplicate function definition.
- `AsyncSchemaError` — a schema's `validate` returned a thenable; this engine is synchronous only.
- `RuleQueryError` — queried a function rule directly (call it via `ctx.call` instead).
- `OverrideError` — a `with` override target didn't start with `input` or `data`.
- `DuplicatePackageError` — `Engine.add()` got a module (or bundle member) whose package name is already registered on this engine. The colliding name is on `.packageName`; the rejected `add()` is atomic, so the engine stays usable.
- `PolicyError` — base class; every error above extends it, so `catch (e) { if (e instanceof PolicyError) … }` covers them all.

## Layout

```
src/
  schema.ts      Standard Schema v1 type spec (no runtime dep)
  match.ts       match() — first-match-wins helper
  proxy.ts       Tree<R> + makePackageProxy — typed proxy plumbing
  types.ts       Context<I, D, R>, Decision<T>, Registry, Rule/FuncKeys
  errors.ts      PolicyError + ValidationError + validate()
  store.ts       Store — the data document
  rule.ts        Rule + Complete/Set/Object/Func
  module.ts      Package, Module, module() factory, when/contains sugar, RESERVED
  bundle.ts      Bundle, bundle() factory, RegistryOf
  evaluator.ts   query resolution, schema validation, with-overrides
  engine.ts      public Engine API + Proxy wrapper
  index.ts       barrel export
tests/engine.test.ts
examples/authz.ts
```

## Tests

```bash
bun install
bun run test          # vitest run
bun run coverage      # vitest run --coverage
bun run typecheck     # tsgo --noEmit — also verifies the type-level @ts-expect-error tests
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full dev loop.

## Out of scope

- Parsing `.rego` source
- HTTP server / `/v1/data/*` endpoints
- OPA's built-in function library (`http.send`, `crypto.*`, `time.*`, …)
- Async schemas / async rule evaluation
- Auto-prefixing the package name onto rule names within `ctx.call` (you write `"authz.isAdmin"` in full)
- Forward references between rules in the same module (the `ctx` you receive carries the registry _as of_ the rule being defined; later rules aren't visible yet)
- Partial evaluation / WASM target
