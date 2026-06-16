import type { ReadonlyStore } from "./store.ts";
import type { Tree } from "./proxy.ts";

/**
 * The flat type map that drives end-to-end inference. Keys are fully-qualified
 * rule paths (e.g. `"authz.allow"`); values are the rule's result type, or a
 * callable signature `(...args) => ret` for function rules. Built up by
 * {@link Module} and combined across modules by `bundle()` — you normally never
 * write a `Registry` by hand.
 */
export type Registry = Record<string, unknown>;

/**
 * A single value substitution applied for the duration of one query. The `data`
 * document or a function rule's result at `target` is replaced by `value`,
 * mirroring OPA's `with` keyword. Used in {@link QueryOptions.with}.
 */
export interface Override {
  /** Dotted path of the data entry or rule to override. */
  target: string;
  /** Value to substitute at `target` for this query only. */
  value: unknown;
}

/** Per-query options passed to {@link Engine}'s query callables and `query()`. */
export interface QueryOptions {
  /** The `input` document made available to rules as `ctx.input`. */
  input?: unknown;
  /** Value substitutions applied only for this query. See {@link Override}. */
  with?: readonly Override[];
}

/** Extracts the argument tuple from a registry entry that is a function signature. */
export type ArgsOf<F> = F extends (...args: infer A) => any ? A : never;
/** Extracts the return type from a registry entry that is a function signature. */
export type RetOf<F> = F extends (...args: any) => infer R ? R : never;

/** Union of registry keys whose value is callable — i.e. the function-rule paths. */
export type FuncKeys<R extends Registry> = {
  [K in keyof R]: R[K] extends (...a: any) => any ? K : never;
}[keyof R] &
  string;

/** Union of registry keys whose value is not callable — i.e. the queryable rule paths. */
export type RuleKeys<R extends Registry> = {
  [K in keyof R]: R[K] extends (...a: any) => any ? never : K;
}[keyof R] &
  string;

/** Function-rule entries of `R`, used to type the `ctx` proxy's callable leaves. */
export type FuncEntries<R extends Registry> = { [K in FuncKeys<R>]: R[K] };
/** Queryable rule entries of `R`, used to type the `engine` proxy's callable leaves. */
export type RuleEntries<R extends Registry> = {
  [K in RuleKeys<R>]: (opts?: QueryOptions) => Decision<R[K]>;
};

/**
 * The fixed members of the rule-evaluation context, before the nested
 * function-rule proxy tree is mixed in. See {@link Context}.
 */
export interface ContextBase<I = unknown, D = unknown, R extends Registry = {}> {
  /** The query's `input` document (typed by the module's input schema, if any). */
  readonly input: I;
  /** A frozen snapshot of the data document (typed by the module's data schema, if any). */
  readonly data: D;
  /**
   * A read-only view of the data document — `get(path)` and `version`. The full
   * mutable Store lives on the engine; use `engine.put`/`engine.store` to write.
   */
  readonly store: ReadonlyStore;
  /**
   * Invoke another function rule by path, with statically-checked arguments and
   * return type drawn from the registry.
   */
  call<P extends FuncKeys<R>>(path: P, ...args: ArgsOf<R[P]>): RetOf<R[P]>;
  /** Untyped fallback used only when no function-rule paths are known. */
  call(path: [FuncKeys<R>] extends [never] ? string : never, ...args: unknown[]): unknown;
}

/**
 * The `ctx` object passed to every rule body. Combines the fixed members of
 * {@link ContextBase} (`input`, `data`, `store`, `call`) with a typed proxy tree
 * so sibling function rules can also be invoked as `ctx.pkg.fn(args)`.
 *
 * @typeParam I - the input document type
 * @typeParam D - the data document type
 * @typeParam R - the registry of all rules visible to this context
 */
export type Context<I = unknown, D = unknown, R extends Registry = {}> = ContextBase<I, D, R> &
  Tree<FuncEntries<R>>;

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

/** A path into the data document: either a dotted string (`"a.b.c"`) or an array of segments. */
export type Path = string | readonly string[];

export function splitPath(path: Path): string[] {
  if (typeof path === "string") {
    return path.length === 0 ? [] : path.split(".");
  }
  return [...path];
}

// Keys that, when written through a path-walking sink, can poison Object.prototype
// (or shadow prototype machinery). The engine ingests untrusted data and string
// paths, so every write must refuse these. See assertSafeKey.
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

// Throw before assigning to a prototype-polluting key. `context` is woven into the
// message so the caller can see which sink (e.g. a put path or `with` target) tripped it.
export function assertSafeKey(key: string, context: string): void {
  if (UNSAFE_KEYS.has(key)) {
    throw new TypeError(
      `refusing to write unsafe key "${key}" in ${context} (prototype pollution guard)`,
    );
  }
}
