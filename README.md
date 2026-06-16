# policy-engine

A small, TypeScript-native policy engine inspired by [Open Policy Agent](https://www.openpolicyagent.org/docs). Rules are written as TypeScript functions; input, data, and function signatures are typed and validated via [Standard Schema](https://standardschema.dev) (works with Zod, Valibot, ArkType, Effect Schema). Zero runtime dependencies.

The interesting bits:

- **Method-shaped queries and calls.** `engine.authz.allow({ input })` and `ctx.authz.isAdmin(user)` — typed proxies over the registry. Returns the right type, autocompletes nested package paths, errors on typos. Path strings (`engine.query("authz.allow", …)` and `ctx.call("authz.isAdmin", …)`) still work as escape hatches.
- **The Module/Engine types track every rule you add.** No `<T>` casts at query sites; the registry is built up through fluent generics.
- **No `if` ladders.** A `match()` helper for first-match-wins decisions, plus `m.when` / `m.contains` sugar for OPA-style multi-clause rules.

Runs on [Bun](https://bun.com).

## Install

```bash
bun install
bun add zod   # or any Standard Schema validator
```

## Quick start

```ts
import { z } from "zod";
import { Engine, match, module } from "./src";

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

Run the demo: `bun run examples/authz.ts`.

## Two ways to call: proxy or string

Inside a rule body and at query sites, you can use either form interchangeably:

| | Proxy (preferred) | String (escape hatch) |
|---|---|---|
| Call a function from a rule | `ctx.authz.isAdmin(user)` | `ctx.call("authz.isAdmin", user)` |
| Query a rule from outside | `engine.authz.allow({ input })` | `engine.query("authz.allow", { input })` |
| Nested packages (`a.b.c`) | `engine.policies.admission.deny({...})` | `engine.query("policies.admission.deny", {...})` |

The proxy form gives you autocomplete on package and rule names, errors on typos at any segment, and reads as plain method calls. The string form is useful for genuinely-dynamic paths and stays available at runtime.

### Reserved root segments

Because `ctx` and `engine` already have built-in members, the following package roots collide with the proxy:

```
input, data, store, call    (on ctx)
add, put, query             (on engine)
store                       (also on engine)
```

`module("input", …)` throws at construction with a clear "reserved" message.

## Concepts

| OPA | This library |
|---|---|
| Rego module | `Module<P, I, D, R>` (P = package, R = accumulated rule registry) |
| Package path (`a.b.c`) | `Package` (dotted name) |
| `default allow := false` | `module.default(name, value)` |
| Complete rule (`allow := …`) | `module.complete(name, fn)` — also `module.when(name, pred)` |
| Partial set (`deny contains msg`) | `module.set(name, fn*)` — also `module.contains(name, pred, value)` |
| Partial object (`apps[h] := app`) | `module.object(name, fn*)` |
| User function | `module.func(name, schemas?, fn)` (call via `ctx.call`) |
| `data` document | `engine.put(path, value)` |
| `input` document | per-query, validated against the module's schema |
| `with input as …` | `engine.query(path, { with: [{ target, value }] })` |
| Bundle | `bundle({ modules, data })` (factory infers types) or `new Bundle(...)` (untyped) |

A query returns a discriminated `Decision<T>`:

```ts
type Decision<T> =
  | { defined: true; result: T }
  | { defined: false };
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
  store: Store;
  call<P extends FuncKeys<R>>(path: P, ...args: ArgsOf<R[P]>): RetOf<R[P]>;
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
- **Defaults** kick in only when *all* complete rules return `undefined`.
- **`with`-overrides** are scoped to a single query and don't mutate originals.
- **Schemas are sync-only.** If a schema's `validate` returns a Promise, the engine throws.

## Trade-offs of the typed-path design

- `Engine`/`Module` hover info gets long. Worth it for the inference.
- Modules built dynamically (in a loop, in a factory function) lose per-rule typing — they fall back to `Module<string, unknown, unknown, {}>` and the registry stays empty. Use the typed factory for static modules; cast for dynamic.
- The `Engine.query` and `ctx.call` typed overloads only accept paths in the registry. For genuinely-dynamic strings, cast to the escape hatch: `(engine.query as (p: string) => unknown)(somePath)`.

## Errors

- `ValidationError` — input, data, function args, or function output failed schema validation.
- `ConflictError` — two complete rules / two `object` entries disagree.
- `UnknownRuleError` — query path didn't resolve at runtime.
- `RuleKindMismatchError` — re-declaring a rule with a different kind, or duplicate function definition.
- `PolicyError` — base class.

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
bun test
```

## Out of scope

- Parsing `.rego` source
- HTTP server / `/v1/data/*` endpoints
- OPA's built-in function library (`http.send`, `crypto.*`, `time.*`, …)
- Async schemas / async rule evaluation
- Auto-prefixing the package name onto rule names within `ctx.call` (you write `"authz.isAdmin"` in full)
- Forward references between rules in the same module (the `ctx` you receive carries the registry *as of* the rule being defined; later rules aren't visible yet)
- Partial evaluation / WASM target
