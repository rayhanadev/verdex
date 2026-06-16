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

const decision = engine.authz.allow({ input: { role: "admin" } });
if (decision.defined) {
  decision.result; // true — typed as boolean, no casts
}
```

## Why you might like it

- **Rules are just functions.** No policy language to learn, no source to parse. If you can write a predicate, you can write a rule.
- **The types follow you everywhere.** `engine.authz.allow(...)` autocompletes the package and rule names, infers the result type, and a typo is a compile error — not a runtime surprise. No `<T>` at the call site.
- **Validation is built in.** Input, data, and function signatures are checked with [Standard Schema](https://standardschema.dev), so [Zod](https://zod.dev), [Valibot](https://valibot.dev), [ArkType](https://arktype.io), and Effect Schema all just work.
- **Zero runtime dependencies**, and nothing host-specific — it runs anywhere modern ESM does (Bun, Node, Deno, the browser, the edge).

## Install

```bash
bun add @rayhanadev/verdex
bun add zod # or any Standard Schema validator
```

> verdex ships TypeScript source, so consume it from any toolchain that resolves `.ts`: Bun, a bundler (Vite/esbuild/Rollup), Node ≥ 22.18 (type stripping), Deno, or `tsx`.

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

### Decisions, not exceptions

A query returns a `Decision<T>` — a discriminated union, so the "no rule matched" case is something you handle, not something you forget:

```ts
type Decision<T> = { readonly defined: true; readonly result: T } | { readonly defined: false };

const d = engine.authz.allow({ input });
if (d.defined) {
  // d.result is T in here
}
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

### Helpers your rules can call

Pull shared logic into a `func` and call it from any rule — through the same typed proxy, so the arguments and return type are checked:

```ts
const User = z.object({ role: z.string() });

const authz = module("authz")
  .func("isAdmin", { args: [User], output: z.boolean() }, (_ctx, user) => user.role === "admin")
  .complete("allow", (ctx) => (ctx.authz.isAdmin({ role: "admin" }) ? true : undefined));
```

### Policies over data

Rules can read a shared `data` document — set it with `engine.put`, read it as `ctx.data` (validated against the module's `data` schema if you give it one). `object` rules build a keyed lookup out of it:

```ts
const apps = module("apps", {
  data: z.object({ list: z.array(z.object({ host: z.string(), name: z.string() })) }),
}).object("byHost", function* (ctx) {
  for (const a of ctx.data.list) yield [a.host, a.name];
});

const engine = new Engine().add(apps).put("list", [{ host: "a.com", name: "alpha" }]);
engine.apps.byHost(); // { defined: true, result: { "a.com": "alpha" } }
```

Want to test a "what if" without touching the real data? Override input or data for a single query:

```ts
engine.authz.allow({ input, with: [{ target: "input.role", value: "admin" }] });
```

## Rule kinds at a glance

| Builder                                            | OPA analogue             | What it gives you                                       |
| -------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| `.default(name, value)`                            | `default allow := false` | the fallback when nothing matches                       |
| `.complete(name, fn)`                              | `allow := …`             | one value; clauses must agree or it's a `ConflictError` |
| `.when(name, pred[, value])`                       | `allow if {…}`           | sugar for a `complete` clause                           |
| `.set(name, fn*)` / `.contains(name, pred, value)` | `deny contains msg`      | a deduped array                                         |
| `.object(name, fn*)`                               | `apps[h] := app`         | a keyed object                                          |
| `.func(name, schemas?, fn)`                        | a function               | a helper callable via `ctx.<pkg>.<fn>(…)`               |

## Proxy or string — your call

Everything you can do with the typed proxy has a string-path escape hatch, handy for genuinely dynamic paths:

|              | Proxy (typed)                   | String                                   |
| ------------ | ------------------------------- | ---------------------------------------- |
| Query a rule | `engine.authz.allow({ input })` | `engine.query("authz.allow", { input })` |
| Call a func  | `ctx.authz.isAdmin(user)`       | `ctx.call("authz.isAdmin", user)`        |

The proxy gives you autocomplete and typo-checking on every path segment; the string form trades that for a plain `string`. (One small gotcha: because `ctx`/`engine` have their own members, a handful of package roots — `input`, `data`, `store`, `call`, `add`, `put`, `query`, `modules` — are reserved, and `module("input")` throws an explanatory error rather than getting silently shadowed.)

## Good to know

- **Rules are pure.** `ctx.input` and `ctx.data` are deep-frozen per query, and `ctx.store` is read-only — a rule can't reach out and mutate shared state. Writes go through `engine.put`.
- **Package names are unique per engine.** Adding two modules with the same package name throws `DuplicatePackageError` (combining clauses across modules is intentionally out of scope for v0.1).
- **Evaluation is synchronous.** If a schema's `validate` returns a promise, you get an `AsyncSchemaError` — keep schemas sync.
- **Deep equality (used for set dedup and conflict detection) is for JSON-shaped values** — own string keys, with `Date`/`Map`/`Set`/`RegExp`/typed arrays handled. Symbol keys are ignored.
- Every error extends `PolicyError`, so a single `catch (e) { if (e instanceof PolicyError) … }` covers `ValidationError`, `ConflictError`, `UnknownRuleError`, `RuleQueryError`, `OverrideError`, `DuplicatePackageError`, and friends.

## Security

verdex evaluates policies over untrusted input and data, so the store is hardened against prototype pollution: `engine.put`, `delete`, bundle data, and `with` targets all reject `__proto__` / `prototype` / `constructor` segments (throwing `TypeError`), and reads only surface own properties. `engine.put("__proto__.role", "admin")` throws instead of poisoning `Object.prototype` or flipping a default-deny policy.

Found a vulnerability? Please report it privately — see [SECURITY.md](./SECURITY.md).

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) to get set up, and [`examples/authz.ts`](./examples/authz.ts) for a fuller policy you can run with `bun run examples/authz.ts`.

## License

[MIT](./LICENSE) © Rayhan Noufal Arayilakath
