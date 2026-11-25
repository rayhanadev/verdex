import type { PolicyError } from "./errors.ts";
import type { RuleKind } from "./rule.ts";
import type { ReadonlyStore } from "./store.ts";
import type { Below, Join, Segment } from "./proxy.ts";

/**
 * The type map that drives end-to-end inference: a **union of single-path
 * objects**, one per rule — e.g. `{ readonly "authz.allow": RuleEntry<boolean> } |
 * { readonly "authz.isAdmin": (u: User) => boolean }`. Values are a
 * {@link RuleEntry} for queryable rules, or a callable signature `(...args) => ret`
 * for function rules. Built up by {@link Module} and combined across modules by
 * `bundle()` and `Engine.add()` — you normally never write a `Registry` by hand.
 *
 * A union stays flat however many modules and clauses you add, so type-checking
 * cost grows linearly (0.2's nested intersections grew super-linearly). The empty
 * registry is `never`.
 */
export type Registry = Record<string, unknown>;

/** One registry member: the entry `E` at path `P`. */
export type PathEntry<P extends string, E> = { readonly [K in P]: E };

/** Every path in the registry `R`. */
export type PathsOf<R> = R extends unknown ? keyof R & string : never;

/** The registry entry at path `P`, or `never` if `R` has none. */
export type EntryAt<R, P extends string> = R extends { readonly [K in P]: infer E } ? E : never;

/**
 * The registry entry for a queryable rule. It carries everything the engine's
 * typed surface needs to know about the rule at a path.
 *
 * @typeParam T - the rule's result type
 * @typeParam I - the `input` a query passes (the module input schema's *input* type)
 * @typeParam D - the per-query `data` a query may pass (the module data schema's input type)
 * @typeParam A - `true` when the rule always produces a value
 */
export interface RuleEntry<T = unknown, I = unknown, D = unknown, A extends boolean = boolean> {
  /** The rule's result type. */
  readonly result: T;
  /** The `input` document a query must pass. */
  readonly input: I;
  /** The per-query `data` document a query may pass. */
  readonly data: D;
  /**
   * Whether the rule is always defined: it has a `default`, or it is a `set` /
   * `object` rule. `boolean` (i.e. `true | false`) once any clause makes it so.
   */
  readonly alwaysDefined: A;
}

/** The result type of a registry entry. */
export type ResultOf<E> = E extends RuleEntry<infer T, any, any, any> ? T : never;

/**
 * The value a rule reference (`ctx.<pkg>.<rule>()`) returns: the result for an
 * always-defined rule, otherwise the result or `undefined`.
 */
type ValueOf<E> =
  E extends RuleEntry<infer T, any, any, infer A> ? (true extends A ? T : T | undefined) : never;

/**
 * A single value substitution applied for the duration of one query. The `input`
 * or `data` document at `target` is replaced by `value`, mirroring OPA's `with`
 * keyword. Used in {@link QueryOptions.with}.
 */
export interface Override {
  /** Dotted path of the entry to override; must start with `input` or `data`. */
  target: string;
  /** Value to substitute at `target` for this query only. */
  value: unknown;
}

/**
 * Per-query options passed to {@link Engine}'s query callables and `query()`.
 *
 * @typeParam I - the `input` type the queried rule accepts
 * @typeParam D - the per-query `data` type the queried rule accepts
 */
export interface QueryOptions<I = unknown, D = unknown> {
  /** The `input` document made available to rules as `ctx.input`. */
  input?: I;
  /**
   * A `data` document for this query only. It replaces the engine's store
   * document (`ctx.data`) for this query; the engine is not changed.
   */
  data?: D;
  /** Value substitutions applied only for this query. See {@link Override}. */
  with?: readonly Override[];
}

/**
 * Options for the non-throwing `evaluate()` API: every {@link QueryOptions} field
 * plus error and trace controls.
 */
export interface EvaluateOptions<I = unknown, D = unknown> extends QueryOptions<I, D> {
  /**
   * Return `true` for a thrown value that must propagate unchanged instead of
   * becoming `{ ok: false }` (for example a host "panic" type). Overrides the
   * engine's `rethrow` option for this call.
   */
  rethrow?: (cause: unknown) => boolean;
  /** Record a {@link Trace} and return it on the evaluation (success or failure). */
  trace?: boolean;
}

/** {@link QueryOptions} with a required `input`, used when a rule's input type excludes `undefined`. */
interface RequiredInput<I, D> extends QueryOptions<I, D> {
  input: I;
}
/** {@link EvaluateOptions} with a required `input`. */
interface RequiredEvaluateInput<I, D> extends EvaluateOptions<I, D> {
  input: I;
}

/**
 * The argument list of a typed query for the registry entry `E`: the options are
 * optional when the rule's input accepts `undefined`, and required (with a
 * required `input`) otherwise.
 */
export type QueryArgs<E> =
  E extends RuleEntry<any, infer I, infer D, any>
    ? undefined extends I
      ? [opts?: QueryOptions<I, D>]
      : [opts: RequiredInput<I, D>]
    : [opts?: QueryOptions];

/** The argument list of a typed `evaluate()` call for the registry entry `E`. */
export type EvaluateArgs<E> =
  E extends RuleEntry<any, infer I, infer D, any>
    ? undefined extends I
      ? [opts?: EvaluateOptions<I, D>]
      : [opts: RequiredEvaluateInput<I, D>]
    : [opts?: EvaluateOptions];

/** Extracts the argument tuple from a registry entry that is a function signature. */
export type ArgsOf<F> = F extends (...args: infer A) => any ? A : never;
/** Extracts the return type from a registry entry that is a function signature. */
export type RetOf<F> = F extends (...args: any) => infer R ? R : never;

// The key helpers distribute over the registry union, so each member (one path)
// is inspected once and the results are cached per member.

/** Union of registry paths whose value is callable — i.e. the function-rule paths. */
export type FuncKeys<R extends Registry> = R extends unknown
  ? { [K in keyof R]: R[K] extends (...a: any) => any ? K : never }[keyof R] & string
  : never;

/** Union of registry paths whose value is not callable — i.e. the queryable rule paths. */
export type RuleKeys<R extends Registry> = R extends unknown
  ? { [K in keyof R]: R[K] extends (...a: any) => any ? never : K }[keyof R] & string
  : never;

/**
 * Union of registry paths for rules that are always defined (a `default`, or a
 * `set` / `object` rule) — the paths `decide()` accepts.
 */
export type DecideKeys<R extends Registry> = R extends unknown
  ? {
      [K in keyof R]: R[K] extends RuleEntry<any, any, any, infer A>
        ? true extends A
          ? K
          : never
        : never;
    }[keyof R] &
      string
  : never;

/**
 * A leaf of the `ctx` proxy tree: a function rule keeps its signature; a
 * queryable rule becomes a zero-argument rule reference returning its value.
 */
type CtxLeaf<E> = E extends (...a: any) => any ? E : () => ValueOf<E>;

/**
 * The nested `ctx` proxy view of registry `R` over the paths `K`, built lazily
 * one segment at a time.
 */
export type CtxTree<R, K extends string, P extends string = ""> = {
  [C in Segment<K>]: (C extends K ? CtxLeaf<EntryAt<R, Join<P, C>>> : unknown) &
    ([Below<K, C>] extends [never] ? unknown : CtxTree<R, Below<K, C>, Join<P, C>>);
};

/** A typed query callable for one rule, plus its non-throwing and explaining forms. */
export interface RuleHandle<E> {
  /** Query the rule and return its {@link Decision}. Throws on failure. */
  (...args: QueryArgs<E>): Decision<ResultOf<E>>;
  /** Query the rule without throwing; failures come back as `{ ok: false, error }`. */
  evaluate(...args: EvaluateArgs<E>): Evaluation<ResultOf<E>>;
  /** Query the rule and return the decision with a full {@link Trace}. Throws on failure. */
  explain(...args: QueryArgs<E>): Explanation<ResultOf<E>>;
}

/** The `decide` member that {@link Handle} adds for always-defined rules. */
export interface DecideHandle<E> {
  /** Query the rule and return its result directly. Throws on failure. */
  decide(...args: QueryArgs<E>): ResultOf<E>;
}

/** The handle for registry entry `E`: a {@link RuleHandle}, plus `decide` when the rule is always defined. */
export type Handle<E> = RuleHandle<E> &
  (E extends RuleEntry<any, any, any, infer A> ? (true extends A ? DecideHandle<E> : {}) : {});

/**
 * The nested `engine` proxy view of registry `R` over the paths `K` (its
 * queryable rules), built lazily one segment at a time. Each complete path is a
 * {@link Handle}.
 */
export type EngineTree<R, K extends string, P extends string = ""> = {
  [C in Segment<K>]: (C extends K ? Handle<EntryAt<R, Join<P, C>>> : unknown) &
    ([Below<K, C>] extends [never] ? unknown : EngineTree<R, Below<K, C>, Join<P, C>>);
};

/**
 * The fixed members of the rule-evaluation context, before the nested
 * rule-reference proxy tree is mixed in. See {@link Context}.
 */
export interface ContextBase<I = unknown, D = unknown, R extends Registry = never> {
  /** The query's `input` document (typed by the module's input schema, if any). */
  readonly input: I;
  /** A frozen snapshot of the data document (typed by the module's data schema, if any). */
  readonly data: D;
  /**
   * A read-only view of the engine's data store — `get(path)` and `version`. The
   * full mutable Store lives on the engine; use `engine.put`/`engine.store` to write.
   */
  readonly store: ReadonlyStore;
  /**
   * Invoke a function rule by path, with statically-checked arguments and
   * return type drawn from the registry.
   */
  call<P extends FuncKeys<R>>(path: P, ...args: ArgsOf<EntryAt<R, P>>): RetOf<EntryAt<R, P>>;
  /** Untyped fallback used only when no function-rule paths are known. */
  call(path: [FuncKeys<R>] extends [never] ? string : never, ...args: unknown[]): unknown;
  /**
   * Read another rule's {@link Decision} by path within the same query. The result
   * is memoized for the rest of the query; a reference cycle throws `CycleError`.
   */
  query<P extends RuleKeys<R>>(path: P): Decision<ResultOf<EntryAt<R, P>>>;
  /** Untyped fallback used only when no rule paths are known. */
  query<T = unknown>(path: [RuleKeys<R>] extends [never] ? string : never): Decision<T>;
}

/**
 * The `ctx` object passed to every rule body. Combines the fixed members of
 * {@link ContextBase} (`input`, `data`, `store`, `call`, `query`) with a typed
 * proxy tree: earlier function rules are callable as `ctx.pkg.fn(args)`, and
 * earlier queryable rules are readable as `ctx.pkg.rule()`.
 *
 * @typeParam I - the input document type
 * @typeParam D - the data document type
 * @typeParam R - the registry of all rules visible to this context
 */
export type Context<I = unknown, D = unknown, R extends Registry = never> = ContextBase<I, D, R> &
  CtxTree<R, PathsOf<R>>;

/**
 * The result of querying a rule. A discriminated union on `defined`: when a rule
 * produced a value, `defined` is `true` and `result` holds it; when no clause
 * matched and there was no default, `defined` is `false` and `result` is absent.
 *
 * @typeParam T - the rule's result type
 */
export type Decision<T = unknown> =
  | { readonly defined: true; readonly result: T }
  | { readonly defined: false; readonly result?: undefined };

/**
 * The outcome of the non-throwing `evaluate()` API. Either the query produced a
 * {@link Decision}, or it failed with a {@link PolicyError}. A value thrown by a
 * rule body is wrapped in an `EvaluationError` whose `cause` holds it.
 *
 * @typeParam T - the rule's result type
 */
export type Evaluation<T = unknown> =
  | { readonly ok: true; readonly decision: Decision<T>; readonly trace?: Trace }
  | { readonly ok: false; readonly error: PolicyError; readonly trace?: Trace };

/** Names one clause of a rule: its position and, if declared, its `id`. */
export interface ClauseRef {
  /** Zero-based position of the clause among the rule's clauses, in declaration order. */
  readonly index: number;
  /** The clause `id` given in the builder options, if any. */
  readonly id?: string;
}

/** What one clause did during an explained query. */
export interface ClauseTrace extends ClauseRef {
  /** Whether the clause contributed: a value for `complete`, any member/entry for `set`/`object`. */
  readonly matched: boolean;
  /** The clause's contribution: its value, or the members / entries it yielded. */
  readonly value?: unknown;
}

/** One function call or rule reference made during an explained query. */
export interface CallTrace {
  /** `func` for a function rule call; `rule` for a rule reference (`ctx.pkg.rule()` / `ctx.query`). */
  readonly kind: "func" | "rule";
  /** The fully-qualified path that was called. */
  readonly path: string;
  /** The arguments passed (always empty for a rule reference). */
  readonly args: readonly unknown[];
  /** The value returned: the function's output, or the referenced rule's {@link Decision}. */
  readonly result: unknown;
  /** `true` when the result came from the per-query memo instead of a fresh evaluation. */
  readonly cached: boolean;
  /** The clauses of a referenced rule, when it was evaluated (not cached). */
  readonly clauses?: readonly ClauseTrace[];
}

/** Identifies one module's policy for audit records. */
export interface PolicyRef {
  /** The module's package name. */
  readonly package: string;
  /** The module's declared `version`, if any. */
  readonly version?: string | number;
  /** A stable hash of the module's structure, rule bodies, defaults and version. */
  readonly fingerprint: string;
}

/** The evaluation record that `explain()` and `evaluate({ trace: true })` return. */
export interface Trace {
  /** The queried rule path. */
  readonly path: string;
  /** The queried rule's kind (`complete` for a default-only rule). */
  readonly kind: RuleKind;
  /** What each clause of the queried rule did, in declaration order. */
  readonly clauses: readonly ClauseTrace[];
  /** `true` when no clause matched and the rule's default produced the result. */
  readonly defaulted: boolean;
  /** Function calls and rule references made during the query, in call order. */
  readonly calls: readonly CallTrace[];
  /** The policy that decided: the engine fingerprint and every module the query touched. */
  readonly policy: { readonly fingerprint: string; readonly modules: readonly PolicyRef[] };
  /** Wall-clock duration of the evaluation in milliseconds (high resolution where available). */
  readonly durationMs: number;
}

/** The result of `explain()`: the {@link Decision} plus its {@link Trace}. */
export interface Explanation<T = unknown> extends Trace {
  /** The decision the query produced — identical to what `query()` returns. */
  readonly decision: Decision<T>;
}

/** Documentation metadata for a module or a rule, surfaced by `engine.rules()`. */
export interface Metadata {
  /** A human-readable description. */
  readonly description?: string;
  /** References for readers, such as a doc link or `"AGENTS.md#documents"`. */
  readonly see?: string | readonly string[];
  /** Arbitrary extra metadata (owner, tags, …). Shallow-merged across clauses of a rule. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** Options accepted by clause builders: rule {@link Metadata} plus an optional clause `id`. */
export interface ClauseOptions extends Metadata {
  /** A stable name for this clause, reported by `explain()` and in `EvaluationError`. Unique per rule. */
  readonly id?: string;
}

/** Introspection record for one module, from `engine.rules()`. */
export interface ModuleInfo {
  /** The module's package name. */
  readonly package: string;
  /** The module's declared `version`, if any. */
  readonly version?: string | number;
  /** The module's description, if any. */
  readonly description?: string;
  /** The module's references, normalized to an array. */
  readonly see: readonly string[];
  /** The module's arbitrary metadata. */
  readonly meta: Readonly<Record<string, unknown>>;
  /** A stable hash of the module's structure, rule bodies, defaults and version. */
  readonly fingerprint: string;
}

/**
 * Introspection record for one rule, from `engine.rules()`.
 *
 * @typeParam P - the union of known rule paths
 */
export interface RuleInfo<P extends string = string> {
  /** The fully-qualified rule path. */
  readonly path: P;
  /** The rule's package name. */
  readonly package: string;
  /** The rule's name within its package. */
  readonly name: string;
  /** The rule's kind (`complete` for a default-only rule). */
  readonly kind: RuleKind;
  /** Whether the rule declares a `default`. */
  readonly hasDefault: boolean;
  /** How many clauses the rule has. */
  readonly clauses: number;
  /** The clause ids that were declared, in clause order. */
  readonly ids: readonly string[];
  /** The rule's description, if any. */
  readonly description?: string;
  /** The rule's references, normalized to an array. */
  readonly see: readonly string[];
  /** The rule's merged arbitrary metadata. */
  readonly meta: Readonly<Record<string, unknown>>;
  /** The module that declares the rule. */
  readonly module: ModuleInfo;
}

/** Options for `new Engine(options)`. */
export interface EngineOptions {
  /**
   * What to do when an `input`/`data` document, a `with` value or an `object`
   * rule result contains an own `__proto__`, `prototype` or `constructor` key.
   * `"reject"` (the default) fails the query with `UnsafeKeyError`; `"drop"`
   * removes the key and continues.
   */
  unsafeKeys?: "reject" | "drop";
  /**
   * Default for {@link EvaluateOptions.rethrow}: return `true` for a thrown value
   * that `evaluate()` must propagate unchanged.
   */
  rethrow?: (cause: unknown) => boolean;
}

/** A path into the data document: either a dotted string (`"a.b.c"`) or an array of segments. */
export type Path = string | readonly string[];

export function splitPath(path: Path): string[] {
  if (typeof path === "string") {
    return path.length === 0 ? [] : path.split(".");
  }
  return [...path];
}

// Keys that, when written through a path-walking sink or copied by assignment,
// can poison a prototype (or shadow prototype machinery). The engine ingests
// untrusted data and string paths, so every write and every snapshot must refuse
// these. See assertSafeKey and snapshot.ts.
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

// Throw before assigning to a prototype-polluting key. `context` is woven into the
// message so the caller can see which sink (e.g. a put path or `with` target) tripped it.
export function assertSafeKey(key: string, context: string): void {
  if (UNSAFE_KEYS.has(key)) {
    throw new TypeError(
      `refusing to write unsafe key "${key}" in ${context} (prototype pollution guard)`,
    );
  }
}
