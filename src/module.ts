import {
  CompleteRule,
  FuncRule,
  ObjectRule,
  Rule,
  SetRule,
  type ClauseInfo,
  type CompleteFn,
  type FuncFn,
  type FuncSchemas,
  type ObjectFn,
  type SetFn,
} from "./rule.ts";
import { PolicyError, RuleKindMismatchError } from "./errors.ts";
import type { StandardSchemaV1 } from "./schema.ts";
import type {
  ClauseOptions,
  Context,
  EntryAt,
  Metadata,
  PathEntry,
  Registry,
  RuleEntry,
} from "./types.ts";

/**
 * A parsed package name (e.g. `"authz.http"`) holding both the original string
 * and its dot-split segments. Created internally by {@link Module}.
 * @internal
 */
export class Package {
  readonly segments: readonly string[];
  constructor(public readonly name: string) {
    this.segments = name.length === 0 ? [] : name.split(".");
  }
  toString(): string {
    return this.name;
  }
}

type ArgsOut<T extends ReadonlyArray<StandardSchemaV1>> = {
  [K in keyof T]: StandardSchemaV1.InferOutput<T[K]>;
};

// The registry is a union of single-path objects (see Registry). Adding a clause
// for a new path appends a member; adding a clause for an existing path swaps that
// one member for a merged entry. Either way the union stays flat, so long builder
// chains, `bundle()` and chained `Engine.add()` type-check in linear time with no
// depth limit (0.2's nested `Omit<R, K> & {…}` grew super-linearly: 7.7 s for an
// 80-module bundle).
//
// Multiple complete/set/object clauses for the same name combine, so a repeated
// rule unions its result type and ORs its "always defined" flag.
type AddRule<R extends Registry, K extends string, T, QI, QD, A extends boolean> = [
  EntryAt<R, K>,
] extends [never]
  ? R | PathEntry<K, RuleEntry<T, QI, QD, A>>
  : Exclude<R, PathEntry<K, unknown>> | PathEntry<K, MergeRule<EntryAt<R, K>, T, A>>;
type MergeRule<E, T, A extends boolean> =
  E extends RuleEntry<infer T0, infer I0, infer D0, infer A0>
    ? RuleEntry<T0 | T, I0, D0, A0 | A>
    : RuleEntry<T, unknown, unknown, A>;
// Function rules cannot be redeclared, so a func entry is simply appended.
type AddFunc<R extends Registry, K extends string, F> = R | PathEntry<K, F>;

/**
 * Options for {@link module}: the `input` / `data` Standard Schemas plus
 * documentation metadata and a `version` that is reported in traces and folded
 * into the policy fingerprint.
 */
export interface ModuleOptions<
  I = unknown,
  D = unknown,
  QI = unknown,
  QD = unknown,
> extends Metadata {
  /** Schema validating (and typing) the `input` document of every query against this module. */
  input?: StandardSchemaV1<QI, I>;
  /** Schema validating (and typing) the `data` document for this module's rules. */
  data?: StandardSchemaV1<QD, D>;
  /** A version label for audit records (e.g. `3` or `"2026-11"`); reported as `pkg@version`. */
  version?: string | number;
}

interface ModuleState {
  readonly rules: ReadonlyMap<string, readonly Rule[]>;
  readonly defaults: ReadonlyMap<string, unknown>;
  readonly meta: ReadonlyMap<string, Metadata>;
  readonly order: readonly string[];
}

const EMPTY_STATE: ModuleState = Object.freeze({
  rules: new Map(),
  defaults: new Map(),
  meta: new Map(),
  order: Object.freeze([]),
});

// Builders hand the next state to the constructor through this slot, so the
// public constructor keeps its `(packageName, options)` signature. Construction is
// synchronous, so the slot is always consumed by the `new` that follows.
let pendingState: ModuleState | undefined;

/**
 * A namespaced collection of rules sharing an `input`/`data` shape, built up with
 * a fluent, type-accumulating API. Modules are immutable: each builder method
 * returns a **new** module with that rule's path folded into the registry `R`,
 * and leaves the module it was called on unchanged — so forking a base module
 * into variants is safe. Create one with {@link module}.
 *
 * @typeParam P - the package-name literal type (e.g. `"authz"`)
 * @typeParam I - the input document type rules see, narrowed by the input schema
 * @typeParam D - the data document type rules see, narrowed by the data schema
 * @typeParam R - the accumulated registry of rule paths declared so far
 * @typeParam QI - the input type a query passes (the input schema's input type)
 * @typeParam QD - the per-query data type a query may pass (the data schema's input type)
 */
export class Module<
  P extends string = string,
  I = unknown,
  D = unknown,
  R extends Registry = never,
  QI = unknown,
  QD = unknown,
> {
  /** The parsed package this module's rules live under. */
  readonly package: Package;
  /** Schema validating the `input` document for queries against this module, if set. */
  readonly inputSchema: StandardSchemaV1<unknown, I> | undefined;
  /** Schema validating the `data` document for this module, if set. */
  readonly dataSchema: StandardSchemaV1<unknown, D> | undefined;
  /** The module's version label, if set. */
  readonly version: string | number | undefined;
  /** The module's description, if set. */
  readonly description: string | undefined;
  /** The module's references, normalized to an array. */
  readonly see: readonly string[];
  /** The module's arbitrary metadata. */
  readonly meta: Readonly<Record<string, unknown>>;

  private readonly options: ModuleOptions<I, D, QI, QD>;
  private readonly state: ModuleState;

  constructor(packageName: P, options?: ModuleOptions<I, D, QI, QD>) {
    this.package = new Package(packageName);
    this.options = options ?? {};
    this.inputSchema = this.options.input;
    this.dataSchema = this.options.data;
    this.version = this.options.version;
    this.description = this.options.description;
    this.see = toList(this.options.see);
    this.meta = Object.freeze({ ...this.options.meta });
    this.state = pendingState ?? EMPTY_STATE;
    pendingState = undefined;
    Object.freeze(this);
  }

  /**
   * Register a fallback value for `name`, returned when no clause of that rule
   * produces a result. A rule with a default is always defined, so `decide()`
   * accepts it.
   *
   * @param name - the rule name (joined with the package to form its path)
   * @param value - the default value
   * @param meta - optional documentation metadata for the rule
   * @returns a new module, with `name`'s type unioned into the registry
   */
  default<N extends string, V>(
    name: N,
    value: V,
    meta?: Metadata,
  ): Module<P, I, D, AddRule<R, `${P}.${N}`, V, QI, QD, true>, QI, QD> {
    const s = this.state;
    const defaults = new Map(s.defaults);
    defaults.set(name, value);
    return this.derive({
      rules: s.rules,
      defaults,
      meta: mergeMeta(s.meta, name, meta),
      order: s.order.includes(name) ? s.order : [...s.order, name],
    });
  }

  /**
   * Add a `complete` clause: produces at most one value. Multiple clauses on the
   * same name combine, but conflicting values raise a `ConflictError` at query time.
   *
   * @param name - the rule name
   * @param fn - returns the value, or `undefined` when the clause does not apply
   * @param opts - optional clause `id` and rule metadata
   * @returns a new module, with the rule's result type added to the registry
   */
  complete<N extends string, X>(
    name: N,
    fn: CompleteFn<I, D, R, X>,
    opts?: ClauseOptions,
  ): Module<P, I, D, AddRule<R, `${P}.${N}`, X, QI, QD, false>, QI, QD> {
    return this.add(name, new CompleteRule(name, fn, info(opts)), opts);
  }

  /**
   * Add a `set` clause: yields members that are unioned across all clauses of the
   * rule into a single array result. A set rule is always defined.
   *
   * @param name - the rule name
   * @param fn - yields zero or more set members
   * @param opts - optional clause `id` and rule metadata
   * @returns a new module, with the rule typed as an array in the registry
   */
  set<N extends string, X>(
    name: N,
    fn: SetFn<I, D, R, X>,
    opts?: ClauseOptions,
  ): Module<P, I, D, AddRule<R, `${P}.${N}`, X[], QI, QD, true>, QI, QD> {
    return this.add(name, new SetRule(name, fn, info(opts)), opts);
  }

  /**
   * Add an `object` clause: yields `[key, value]` entries merged across clauses
   * into a single object result. An object rule is always defined.
   *
   * @param name - the rule name
   * @param fn - yields `[key, value]` entries
   * @param opts - optional clause `id` and rule metadata
   * @returns a new module, with the rule typed as an object in the registry
   */
  object<N extends string, V>(
    name: N,
    fn: ObjectFn<I, D, R, V>,
    opts?: ClauseOptions,
  ): Module<P, I, D, AddRule<R, `${P}.${N}`, { [k: string]: V }, QI, QD, true>, QI, QD> {
    return this.add(name, new ObjectRule(name, fn, info(opts)), opts);
  }

  /**
   * Register a function rule whose arguments and return value are validated and
   * typed by Standard Schemas. Function rules are invoked via `ctx.call` or the
   * ctx proxy, not queried directly. Calls are memoized per query by argument
   * identity, so keep function bodies pure.
   *
   * @param name - the rule name
   * @param schemas - per-argument (`args`) and `output` Standard Schemas
   * @param fn - the function body, receiving `ctx` plus the schema-typed arguments
   * @param meta - optional documentation metadata for the rule
   * @returns a new module, with the rule typed as a callable in the registry
   */
  func<
    N extends string,
    const Args extends ReadonlyArray<StandardSchemaV1>,
    Out extends StandardSchemaV1,
  >(
    name: N,
    schemas: { args: Args; output: Out },
    fn: FuncFn<I, D, R, ArgsOut<Args>, StandardSchemaV1.InferOutput<Out>>,
    meta?: Metadata,
  ): Module<
    P,
    I,
    D,
    AddFunc<R, `${P}.${N}`, (...args: ArgsOut<Args>) => StandardSchemaV1.InferOutput<Out>>,
    QI,
    QD
  >;
  /**
   * Register a function rule with no schemas; its argument and return types are
   * taken directly from `fn`. Invoke it via `ctx.call` or the ctx proxy.
   *
   * @param name - the rule name
   * @param fn - the function body, receiving `ctx` plus arguments
   * @param meta - optional documentation metadata for the rule
   * @returns a new module, with the rule typed as a callable in the registry
   */
  func<N extends string, Args extends readonly unknown[], Out>(
    name: N,
    fn: FuncFn<I, D, R, Args, Out>,
    meta?: Metadata,
  ): Module<P, I, D, AddFunc<R, `${P}.${N}`, (...args: Args) => Out>, QI, QD>;
  func(
    name: string,
    a:
      | FuncFn<I, D, R, readonly unknown[], unknown>
      | { args: ReadonlyArray<StandardSchemaV1>; output: StandardSchemaV1 },
    b?: FuncFn<I, D, R, readonly unknown[], unknown> | Metadata,
    c?: Metadata,
  ): Module<P, I, D, any, QI, QD> {
    if (typeof a === "function") {
      const meta = b as Metadata | undefined;
      return this.add(name, new FuncRule(name, a as FuncFn<I, D, R, unknown[], unknown>), meta);
    }
    const fn = b as FuncFn<I, D, R, unknown[], unknown>;
    return this.add(name, new FuncRule(name, fn, a satisfies FuncSchemas), c);
  }

  /**
   * Sugar for a `complete` clause that yields `true` when `pred(ctx)` holds and
   * is otherwise undefined — handy for boolean allow/deny rules.
   *
   * @param name - the rule name
   * @param pred - condition tested against the context
   * @returns a new module, with the rule typed as `true` in the registry
   */
  when<N extends string>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
  ): Module<P, I, D, AddRule<R, `${P}.${N}`, true, QI, QD, false>, QI, QD>;
  /**
   * Sugar for a `complete` clause that yields `value` when `pred(ctx)` holds and
   * is otherwise undefined. Pass `opts` as the fourth argument to name the clause
   * (`{ id }`) or document the rule; to name a boolean clause, pass `true` as the
   * value: `.when("allow", pred, true, { id: "owner" })`.
   *
   * @param name - the rule name
   * @param pred - condition tested against the context
   * @param value - the value produced when `pred` is true
   * @param opts - optional clause `id` and rule metadata
   * @returns a new module, with `value`'s type added to the registry
   */
  when<N extends string, V>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
    value: V,
    opts?: ClauseOptions,
  ): Module<P, I, D, AddRule<R, `${P}.${N}`, V, QI, QD, false>, QI, QD>;
  when(
    name: string,
    pred: (ctx: Context<I, D, R>) => boolean,
    value?: unknown,
    opts?: ClauseOptions,
  ): Module<P, I, D, any, QI, QD> {
    const v = arguments.length >= 3 ? value : true;
    const fn = (ctx: Context<I, D, R>) => (pred(ctx) ? v : undefined);
    const clause: ClauseInfo = { id: opts?.id, body: pred, hasValue: true, value: v };
    return this.add(name, new CompleteRule<I, D, R, unknown>(name, fn, clause), opts);
  }

  /**
   * Sugar for a `set` clause that contributes `value` to the rule's set when
   * `pred(ctx)` holds.
   *
   * @param name - the rule name
   * @param pred - condition tested against the context
   * @param value - the member added when `pred` is true
   * @param opts - optional clause `id` and rule metadata
   * @returns a new module, with the rule typed as an array in the registry
   */
  contains<N extends string, V>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
    value: V,
    opts?: ClauseOptions,
  ): Module<P, I, D, AddRule<R, `${P}.${N}`, V[], QI, QD, true>, QI, QD> {
    const fn = function* (ctx: Context<I, D, R>) {
      if (pred(ctx)) yield value;
    };
    const clause: ClauseInfo = { id: opts?.id, body: pred, hasValue: true, value };
    return this.add(name, new SetRule<I, D, R, V>(name, fn, clause), opts);
  }

  getRules(name: string): readonly Rule[] | undefined {
    return this.state.rules.get(name);
  }

  getDefault(name: string): unknown {
    return this.state.defaults.get(name);
  }

  hasDefault(name: string): boolean {
    return this.state.defaults.has(name);
  }

  /** Names of rules that have at least one clause, in declaration order. */
  ruleNames(): readonly string[] {
    return [...this.state.rules.keys()];
  }

  /** Every rule name — including default-only rules — in first-declaration order. */
  allRuleNames(): readonly string[] {
    return this.state.order;
  }

  /** The merged documentation metadata of rule `name`, if any was given. */
  getMeta(name: string): Metadata | undefined {
    return this.state.meta.get(name);
  }

  private add(name: string, rule: Rule, meta: Metadata | undefined): Module<P, I, D, any, QI, QD> {
    const s = this.state;
    const existing = s.rules.get(name);
    if (existing) {
      const firstKind = existing[0]!.kind;
      if (firstKind !== rule.kind) {
        throw new RuleKindMismatchError(name, firstKind, rule.kind);
      }
      if (rule.kind === "func") {
        throw new RuleKindMismatchError(name, "func", "func (duplicate)");
      }
      if (rule.id !== undefined && existing.some((r) => r.id === rule.id)) {
        throw new PolicyError(
          `clause id "${rule.id}" is already used by rule "${this.package.name}.${name}"`,
        );
      }
    }
    const rules = new Map(s.rules);
    rules.set(name, Object.freeze([...(existing ?? []), rule]));
    return this.derive({
      rules,
      defaults: s.defaults,
      meta: mergeMeta(s.meta, name, meta),
      order: s.order.includes(name) ? s.order : [...s.order, name],
    });
  }

  private derive(next: ModuleState): Module<P, I, D, any, QI, QD> {
    pendingState = next;
    return new Module<P, I, D, any, QI, QD>(this.package.name as P, this.options);
  }
}

function info(opts: ClauseOptions | undefined): ClauseInfo | undefined {
  return opts?.id === undefined ? undefined : { id: opts.id };
}

function toList(see: string | readonly string[] | undefined): readonly string[] {
  if (see === undefined) return Object.freeze([]);
  return Object.freeze(typeof see === "string" ? [see] : [...see]);
}

// Later metadata wins for `description` / `see`; `meta` objects merge shallowly.
function mergeMeta(
  current: ReadonlyMap<string, Metadata>,
  name: string,
  next: Metadata | undefined,
): ReadonlyMap<string, Metadata> {
  if (
    next === undefined ||
    (next.description === undefined && next.see === undefined && next.meta === undefined)
  ) {
    return current;
  }
  const prev = current.get(name);
  const merged: Metadata = {
    description: next.description ?? prev?.description,
    see: next.see ?? prev?.see,
    meta: prev?.meta || next.meta ? { ...prev?.meta, ...next.meta } : undefined,
  };
  const out = new Map(current);
  out.set(name, merged);
  return out;
}

/**
 * Package root segments that are forbidden because they collide with built-in
 * members of `ctx` / `engine` (which are exposed through the same proxy tree).
 * {@link module} rejects any package whose first segment is in this set.
 *
 * The set is exactly the real instance members reachable on a `ctx` object
 * (`input`, `data`, `store`, `call`, `query`) or an `Engine` (`add`, `put`,
 * `query`, `store`, `evaluate`, `decide`, `explain`, `compile`, `withData`,
 * `rules`, `fingerprint`, plus the `modules` field) — a package sharing one of
 * those names would be silently shadowed by the member instead of routing through
 * the proxy. `constructor` is included too: it is reachable on both proxy targets
 * via the prototype chain (and is already a prototype-pollution sink), so it can
 * never be a usable package root. Inherited `Object.prototype` members on `ctx`
 * (`hasOwnProperty`, `valueOf`, …) are handled structurally by the proxies'
 * own-property check rather than enumerated here.
 * @internal
 */
export const RESERVED: ReadonlySet<string> = new Set([
  // ctx members
  "input",
  "data",
  "store",
  "call",
  // Engine members (`query` is also a ctx member)
  "add",
  "put",
  "query",
  "modules",
  "evaluate",
  "decide",
  "explain",
  "compile",
  "withData",
  "rules",
  "fingerprint",
  // reachable via the prototype chain on both proxy targets; also a pollution sink
  "constructor",
]);

/**
 * Create a {@link Module} under `packageName`, capturing the name as a literal type
 * for path inference and wiring up optional `input`/`data` validation schemas.
 * The query `input` type is the input schema's *input* type, so a query with the
 * wrong shape is a compile error, while rules see the schema's *output* type.
 *
 * @param packageName - dotted package name (e.g. `"authz.http"`)
 * @param options - optional Standard Schemas for the `input` and `data` documents,
 *   plus `version`, `description`, `see` and `meta`
 * @returns a fresh module to chain rule builders onto
 * @throws {Error} if the package's root segment is {@link RESERVED}
 *
 * @example
 * ```ts
 * const authz = module("authz")
 *   .when("allow", (ctx) => ctx.input.role === "admin");
 * ```
 */
export function module<
  const P extends string,
  I = unknown,
  D = unknown,
  QI = unknown,
  QD = unknown,
>(packageName: P, options?: ModuleOptions<I, D, QI, QD>): Module<P, I, D, never, QI, QD> {
  const root = packageName.split(".")[0]!;
  if (RESERVED.has(root)) {
    throw new Error(
      `package root "${root}" is reserved (collides with ctx/engine members: ${[...RESERVED].join(", ")})`,
    );
  }
  return new Module(packageName, options);
}
