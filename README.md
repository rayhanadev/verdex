# verdex

[![version](https://img.shields.io/npm/v/@rayhanadev/verdex?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/@rayhanadev/verdex)
[![downloads](https://img.shields.io/npm/dt/@rayhanadev/verdex.svg?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/@rayhanadev/verdex)

Authorization logic has a way of rotting. It starts as one `if (user.role === "admin")` and a year later it's a 400-line tangle nobody wants to touch. verdex keeps that logic as small, typed functions you query like methods — `engine.authz.allow({ input })` — with the types flowing all the way through.

It's a tiny policy engine inspired by [Open Policy Agent](https://www.openpolicyagent.org/docs), except the rules are plain TypeScript (no `.rego`, no DSL) and your editor knows about every one of them.

```ts
import { z } from "zod";
import { Engine, module } from "@rayhanadev/verdex";

const authz = module("authz", {
  input: z.object({ role: z.enum(["admin", "member", "guest"]) }),
})
  .default("allow", false) // deny by default
  .when("allow", (ctx) => ctx.input.role === "admin"); // ...unless you're an admin

const engine = new Engine().add(authz);

engine.authz.allow({ input: { role: "admin" } }); // { defined: true, result: true }
engine.decide("authz.allow", { input: { role: "guest" } }); // false — typed as boolean
engine.authz.allow({ input: { role: "root" } }); // ✗ compile error: not a valid role
```

## Why you might like it

- **Rules are just functions.** No policy language to learn, no source to parse. If you can write a predicate, you can write a rule.
- **The types follow you everywhere.** `engine.authz.allow(...)` autocompletes the package and rule names, checks the `input` you pass against the module's schema, infers the result type, and a typo is a compile error — not a runtime surprise. No `<T>` at the call site.
- **Validation is built in.** Input, data, and function signatures are checked with [Standard Schema](https://standardschema.dev), so [Zod](https://zod.dev), [Valibot](https://valibot.dev), [ArkType](https://arktype.io), and Effect Schema all just work.
- **Immutable and safe to share.** Modules and engines are values: deriving one never changes another, and per-request facts never leak between requests.
- **Errors as values, if you want them.** `engine.evaluate(...)` never throws; it returns `{ ok, decision } | { ok, error }`.
- **Explainable.** `engine.explain(...)` tells you which clause decided, what it saw, which helpers ran, and a fingerprint of the policy that made the call.
- **Zero runtime dependencies**, and nothing host-specific — it runs anywhere modern ESM does (Bun, Node, Deno, the browser, the edge).

## Install

```bash
bun add @rayhanadev/verdex
bun add zod # or any Standard Schema validator
```

> Ships compiled ESM **and** CommonJS with type declarations and sourcemaps, so it works out of the box in Node, Bun, Deno, and any bundler — no build step or `.ts` loader on your end.

## Writing policies

A **module** groups rules under a package name. Inside it, you stack up clauses with a fluent API. Here's a realistic one — allow some things, and collect human-readable reasons for the things you deny:

```ts
import { z } from "zod";
import { Engine, module } from "@rayhanadev/verdex";

const authz = module("authz", {
  input: z.object({ role: z.string(), action: z.string() }),
})
  .default("allow", false)
  .when("allow", (ctx) => ctx.input.role === "admin")
  .when("allow", (ctx) => ctx.input.role === "member" && ctx.input.action !== "delete")
  // `contains` collects deduped values into a set — great for explaining a "no"
  .contains("deny", (ctx) => ctx.input.role === "guest", "guests are read-only");

const engine = new Engine().add(authz);
const input = { role: "guest", action: "write" };

engine.authz.allow({ input }); // { defined: true, result: false }
engine.authz.deny({ input }); //  { defined: true, result: ["guests are read-only"] }
```

`default` sets the fallback. `when` adds a clause that contributes its value (defaulting to `true`) when the predicate holds. Multiple `when`/`complete` clauses for the same rule combine — and if two of them disagree on a value, you get a `ConflictError` instead of a silently-wrong answer.

### Modules and engines are immutable

Every builder call returns a **new** module, and `engine.add()` returns a **new** engine. The value you called it on never changes, so forking is safe:

```ts
const base = module("docs").default("edit", false);
const strict = base.when("edit", (ctx) => isOwner(ctx)); // a new module
const lax = base.when("edit", () => true); // another one — `strict` is unaffected

const shared = new Engine().add(ui); // safe to import on the client
const server = shared.add(secrets); // a new engine; `shared` still knows only `ui`
```

### The input is typed

A module's input schema types both sides: rules see the schema's **output** (`ctx.input`, with coercions and defaults applied), and every query surface — `query`, the proxy, `evaluate`, `decide`, `explain`, `compile` — checks the `input` you pass against the schema's **input** type. When the schema rejects `undefined`, `input` is required.

```ts
const docs = module("docs", {
  input: z.object({ viewerId: z.string(), ownerId: z.string(), at: z.coerce.date() }),
}).when("edit", (ctx) => ctx.input.viewerId === ctx.input.ownerId); // ctx.input.at is a Date

const engine = new Engine().add(docs);
engine.docs.edit({ input: { viewerId: "u1", ownerId: "u1", at: "2026-01-01" } }); // ✓
engine.docs.edit({ input: { viewer: 1 } }); // ✗ compile error
```

Modules without an input schema accept any `input`.

### Decisions, not exceptions

A query returns a `Decision<T>` — a discriminated union, so the "no rule matched" case is something you handle, not something you forget:

```ts
type Decision<T> = { readonly defined: true; readonly result: T } | { readonly defined: false };

const d = engine.authz.allow({ input });
if (d.defined) {
  // d.result is T in here
}
```

When a rule is **always defined** — it has a `default`, or it is a `set`/`object` rule — `decide()` skips the narrowing and returns `T` directly. Calling it on a rule that can be undefined is a compile error:

```ts
engine.decide("authz.allow", { input }); // boolean
engine.authz.deny.decide({ input }); // string[]
```

### Errors as values: `evaluate()`

`query()` and `decide()` throw on failure (bad input, conflicting clauses, an exception in a rule body). If your codebase treats errors as values, use `evaluate()` instead — it never throws for an engine or rule failure:

```ts
const r = engine.evaluate("authz.allow", { input }); // or engine.authz.allow.evaluate({ input })
if (r.ok) {
  r.decision; // Decision<boolean>
} else {
  r.error; // a PolicyError: ValidationError, ConflictError, UnsafeKeyError, …
}
```

A value thrown by a rule body comes back as an `EvaluationError`: `cause` holds the thrown value unchanged, and `rulePath`/`clause` name the clause that threw it. To let some values propagate untouched — say, your app's "panic" type — pass a `rethrow` predicate, per engine or per call:

```ts
const engine = new Engine({ rethrow: (cause) => cause instanceof Panic }).add(authz);
engine.evaluate("authz.allow", { input, rethrow: () => false }); // per-call override
```

### Branch without the `if` ladder

For first-match-wins logic, `match()` reads better than a stack of ternaries:

```ts
import { match } from "@rayhanadev/verdex";

const tier = match(user)
  .when((u) => u.banned, "blocked")
  .when((u) => u.role === "admin", "full")
  .when((u) => u.plan === "pro", "extended")
  .otherwise("basic");
```

### Helpers and rule references

Pull shared logic into a `func` and call it from any rule — through the same typed proxy, so the arguments and return type are checked:

```ts
const User = z.object({ role: z.string() });

const authz = module("authz")
  .func("isAdmin", { args: [User], output: z.boolean() }, (_ctx, user) => user.role === "admin")
  .complete("allow", (ctx) => (ctx.authz.isAdmin({ role: "admin" }) ? true : undefined));
```

A rule can also read another rule declared earlier in the same module: `ctx.<pkg>.<rule>()` returns its value (or `undefined` when the rule can be undefined), and `ctx.query(path)` returns its full `Decision`:

```ts
const money = module("money", { input: Payment })
  .contains("elevated", (ctx) => ctx.input.amount >= 250_000, "amount_at_or_above_threshold")
  .contains("elevated", (ctx) => ctx.input.method === "wire", "international_wire")
  .complete("tier", (ctx) => (ctx.money.elevated().length > 0 ? "elevated" : "standard"));
```

Within one query, rule references and function calls are **memoized** (functions by argument identity), so a helper used by five clauses runs once. A reference loop — a rule that, directly or indirectly, reads itself — throws `CycleError`. Keep rule and function bodies pure.

### Policies over data

Rules can read a `data` document as `ctx.data` (validated against the module's `data` schema if you give it one). There are three ways to provide it:

```ts
const apps = module("apps", {
  data: z.object({ list: z.array(z.object({ host: z.string(), name: z.string() })) }),
}).object("byHost", function* (ctx) {
  for (const a of ctx.data.list) yield [a.host, a.name];
});

// 1. Per query — nothing is shared, so it is safe for per-request facts.
engine.apps.byHost({ data: { list } });

// 2. An immutable engine view bound to a document (per tenant, per request, …).
const view = engine.withData({ list });
view.apps.byHost();

// 3. The engine's own store, for long-lived reference data.
const withStore = new Engine().add(apps).put("list", list);
```

Data is validated **once per document**, not once per query: the store document is a frozen snapshot that changes identity on every write, and a deep-frozen per-query document (see [`snapshot()`](#performance)) is cached by identity. Avoid `put` for per-request facts — a shared engine's store is shared by every request; use per-query `data` or `withData`.

Want to test a "what if" without touching the real data? Override input or data for a single query:

```ts
engine.authz.allow({ input, with: [{ target: "input.role", value: "admin" }] });
```

### Explaining a decision

Give clauses stable ids (the fourth argument of `when`/`contains`, the third of `complete`/`set`/`object`) and ask the engine to explain:

```ts
const authz = module("authz", { input: Facts, version: 3 })
  .func("isOwner", (ctx) => ctx.input.viewerId === ctx.input.ownerId)
  .default("allow", false)
  .when("allow", (ctx) => ctx.input.roles.includes("super_admin"), true, { id: "super_admin_role" })
  .when("allow", (ctx) => ctx.authz.isOwner(), true, { id: "owner" });

engine.explain("authz.allow", { input });
// {
//   decision:  { defined: true, result: true },
//   path: "authz.allow", kind: "complete", defaulted: false,
//   clauses:   [ { index: 0, id: "super_admin_role", matched: false },
//                { index: 1, id: "owner", matched: true, value: true } ],
//   calls:     [ { kind: "func", path: "authz.isOwner", args: [], result: true, cached: false } ],
//   policy:    { fingerprint: "…", modules: [ { package: "authz", version: 3, fingerprint: "…" } ] },
//   durationMs: 0.004
// }
```

`engine.fingerprint()` is a stable hash of the whole policy — every module's rules, clause bodies, defaults and version, independent of add order and data — so audit records can say exactly which policy decided. It is not a cryptographic digest. Tracing costs nothing on the normal path: only `explain()` and `evaluate(path, { trace: true })` record anything. Use reason sets (`contains`) for explanations you show users, and `explain()` for audits and debugging.

### Introspection and metadata

`engine.rules()` lists every rule with its kind, default, clause ids and documentation metadata — handy for generated docs and access matrices:

```ts
module("docs", {
  version: 2,
  description: "Document access",
  see: "docs/authz.md",
  meta: { owner: "platform" },
})
  .default("edit", false, { description: "Whether the viewer can edit." })
  .when("edit", isOwner, true, { id: "owner" });

engine.rules();
// [{ path: "docs.edit", kind: "complete", hasDefault: true, clauses: 1, ids: ["owner"],
//    description: "Whether the viewer can edit.", see: [], meta: {}, module: { package: "docs", version: 2, … } }]
```

## Rule kinds at a glance

| Builder                                                            | OPA analogue             | What it gives you                                       |
| ------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------- |
| `.default(name, value[, meta])`                                    | `default allow := false` | the fallback when nothing matches                       |
| `.complete(name, fn[, opts])`                                      | `allow := …`             | one value; clauses must agree or it's a `ConflictError` |
| `.when(name, pred[, value[, opts]])`                               | `allow if {…}`           | sugar for a `complete` clause                           |
| `.set(name, fn*[, opts])` / `.contains(name, pred, value[, opts])` | `deny contains msg`      | a deduped array                                         |
| `.object(name, fn*[, opts])`                                       | `apps[h] := app`         | a keyed object                                          |
| `.func(name, schemas?, fn[, meta])`                                | a function               | a helper callable via `ctx.<pkg>.<fn>(…)`               |

`opts` is `{ id?, description?, see?, meta? }`; `meta` is `{ description?, see?, meta? }`.

## Proxy or string — your call

Everything you can do with the typed proxy has a string-path form, handy for genuinely dynamic paths:

|                         | Proxy (typed)                            | String                                      |
| ----------------------- | ---------------------------------------- | ------------------------------------------- |
| Query a rule            | `engine.authz.allow({ input })`          | `engine.query("authz.allow", { input })`    |
| Query without throwing  | `engine.authz.allow.evaluate({ input })` | `engine.evaluate("authz.allow", { input })` |
| Get the result directly | `engine.authz.allow.decide({ input })`   | `engine.decide("authz.allow", { input })`   |
| Explain                 | `engine.authz.allow.explain({ input })`  | `engine.explain("authz.allow", { input })`  |
| Call a func in a rule   | `ctx.authz.isAdmin(user)`                | `ctx.call("authz.isAdmin", user)`           |
| Read a rule in a rule   | `ctx.authz.allow()` (value)              | `ctx.query("authz.allow")` (Decision)       |

The proxy gives you autocomplete and typo-checking on every path segment; on a typed engine the string form is checked too. (One small gotcha: because `ctx`/`engine` have their own members, a handful of package roots — `input`, `data`, `store`, `call`, `add`, `put`, `query`, `modules`, `evaluate`, `decide`, `explain`, `compile`, `withData`, `rules`, `fingerprint` — are reserved, and `module("input")` throws an explanatory error rather than getting silently shadowed.)

## Performance

A decision costs well under a microsecond for a typical rule. Two tools help in hot paths:

- **`snapshot(value)`** returns a deep-frozen copy that verdex uses without copying again. Each query normally copies its `input` (so a rule can never mutate your objects); pass the same snapshot to many queries — say, the facts behind every decision on one page — and they skip that step. Any deep-frozen value gets the same treatment.
- **`engine.compile(path)`** resolves a path once and returns a direct callable (with `evaluate`, `explain` and, for always-defined rules, `decide`).

```ts
import { snapshot } from "@rayhanadev/verdex";

const facts = snapshot({ viewer, roles });
const canEdit = engine.compile("docs.edit");
// Each input is a fresh object, but its frozen parts (viewer, roles) are reused, not copied.
rows.map((doc) => canEdit.decide({ input: { ...facts, doc } }));
```

Large registries stay cheap to type-check, too: a 160-module `bundle()` checks in well under a second.

## Good to know

- **Rules are pure.** `ctx.input` and `ctx.data` are deep-frozen per query, and `ctx.store` is read-only — a rule can't reach out and mutate shared state. verdex never freezes or mutates your plain objects: it copies what isn't already deep-frozen. (Non-plain values such as `Date` or class instances pass through by reference and are frozen in place, as before.)
- **The store is persistent.** `engine.put` stores a deep-frozen copy of the value, and every write produces a new frozen document. Later changes to your object do not reach the store.
- **Package names are unique per engine.** Adding two modules with the same package name throws `DuplicatePackageError` (combining clauses across modules is intentionally out of scope).
- **Evaluation is synchronous.** If a schema's `validate` returns a promise, you get an `AsyncSchemaError` — keep schemas sync.
- **Deep equality (used for set dedup and conflict detection) is for JSON-shaped values** — own string keys, with `Date`/`Map`/`Set`/`RegExp`/typed arrays handled. Symbol keys are ignored.
- Every engine error extends `PolicyError`, so a single `catch (e) { if (e instanceof PolicyError) … }` covers `ValidationError`, `ConflictError`, `UnknownRuleError`, `RuleQueryError`, `OverrideError`, `DuplicatePackageError`, `UnsafeKeyError`, `CycleError`, and friends.

## Security

verdex evaluates policies over untrusted input and data, so it is hardened against prototype pollution:

- **Writes and paths.** `engine.put`, `delete`, `merge`, bundle data, and `with` targets reject `__proto__` / `prototype` / `constructor` path segments — and `put`/`merge`/bundle data also reject those keys anywhere inside the value — by throwing `TypeError`. Reads only surface own properties. `engine.put("__proto__.role", "admin")` throws instead of poisoning `Object.prototype` or flipping a default-deny policy.
- **Documents.** An `input` or `data` document, a `with` value, a `withData` document, or an `object` rule result that contains an own `__proto__`, `prototype` or `constructor` key fails the query with `UnsafeKeyError`. Before 0.3, the per-query copy assigned an own `"__proto__"` key, which replaced the copy's prototype — so `{"user":{"__proto__":{"role":"admin"}}}` could make a rule reading `user.role` see `"admin"`. Prefer to strip such keys? `new Engine({ unsafeKeys: "drop" })` removes them and continues.
- **Shared state.** Engines are immutable and per-query `data` / `withData` keep per-request facts out of shared state, so concurrent requests cannot see each other's facts.

Found a vulnerability? Please report it privately — see [SECURITY.md](./SECURITY.md).

## Migrating from 0.2

- **Builders and `add()` return new values.** Code that relied on mutation must use the return value:

  ```ts
  // 0.2 (worked by accident)          // 0.3
  const m = module("p");
  let m = module("p");
  m.when("allow", pred);
  m = m.when("allow", pred);
  engine.add(other);
  engine = engine.add(other);
  ```

  Chained calls (`module("p").default(…).when(…)`, `new Engine().add(a).add(b)`) are unchanged. A derived engine gets its own copy of the store, so `put` on one engine no longer affects another.

- **Query input is typed.** A query whose `input` doesn't match the module's input schema is now a compile error, and `input` is required when the schema rejects `undefined`.
- **New reserved package roots:** `evaluate`, `decide`, `explain`, `compile`, `withData`, `rules`, `fingerprint`.
- **Unsafe keys in documents** now fail the query with `UnsafeKeyError` (or are dropped with `unsafeKeys: "drop"`). Values passed to `put`/`merge`/bundle data are checked at every depth (`TypeError`).
- **The store holds frozen copies.** `engine.store.get(…)` and `engine.store.document` return deep-frozen values, and mutating an object after `put` no longer changes the store.
- **Type-level:** the registry is now a union of single-path entries (`Registry`, `RuleEntry`, `RuleKeys`, …), and the empty registry is `never` instead of `{}`. This only matters if you named these types yourself.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) to get set up, and [`examples/authz.ts`](./examples/authz.ts) for a fuller policy you can run with `bun run examples/authz.ts`.

## License

[MIT](./LICENSE) © Rayhan Noufal Arayilakath
