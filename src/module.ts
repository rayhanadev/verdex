import {
  CompleteRule,
  FuncRule,
  ObjectRule,
  Rule,
  SetRule,
  type CompleteFn,
  type FuncFn,
  type FuncSchemas,
  type ObjectFn,
  type SetFn,
} from "./rule.ts";
import { RuleKindMismatchError } from "./errors.ts";
import type { StandardSchemaV1 } from "./schema.ts";
import type { Context, Registry } from "./types.ts";

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

// Add a new path → T, unioning with any existing entry at that path.
// (Multiple complete/set/object clauses for the same name combine, so types union.)
type Add<R extends Registry, P extends string, N extends string, T> = Omit<R, `${P}.${N}`> & {
  [K in `${P}.${N}`]: `${P}.${N}` extends keyof R ? R[`${P}.${N}`] | T : T;
};

/**
 * A namespaced collection of rules sharing an `input`/`data` shape, built up with
 * a fluent, type-accumulating API. Each builder method registers a rule and
 * returns the module with that rule's path folded into the registry `R`, so the
 * engine can later infer query result types. Create one with {@link module}.
 *
 * @typeParam P - the package-name literal type (e.g. `"authz"`)
 * @typeParam I - the input document type, narrowed by the input schema
 * @typeParam D - the data document type, narrowed by the data schema
 * @typeParam R - the accumulated registry of rule paths declared so far
 */
export class Module<P extends string = string, I = unknown, D = unknown, R extends Registry = {}> {
  /** The parsed package this module's rules live under. */
  readonly package: Package;
  /** Schema validating the `input` document for queries against this module, if set. */
  readonly inputSchema: StandardSchemaV1<unknown, I> | undefined;
  /** Schema validating the `data` document for this module, if set. */
  readonly dataSchema: StandardSchemaV1<unknown, D> | undefined;

  private readonly rules: Map<string, Rule[]> = new Map();
  private readonly defaults: Map<string, unknown> = new Map();

  constructor(
    packageName: P,
    schemas?: {
      input?: StandardSchemaV1<unknown, I>;
      data?: StandardSchemaV1<unknown, D>;
    },
  ) {
    this.package = new Package(packageName);
    this.inputSchema = schemas?.input;
    this.dataSchema = schemas?.data;
  }

  /**
   * Register a fallback value for `name`, returned when no clause of that rule
   * produces a result.
   *
   * @param name - the rule name (joined with the package to form its path)
   * @param value - the default value
   * @returns this module, with `name`'s type unioned into the registry
   */
  default<N extends string, V>(name: N, value: V): Module<P, I, D, Add<R, P, N, V>> {
    this.defaults.set(name, value);
    return this as unknown as Module<P, I, D, Add<R, P, N, V>>;
  }

  /**
   * Add a `complete` clause: produces at most one value. Multiple clauses on the
   * same name combine, but conflicting values raise a `ConflictError` at query time.
   *
   * @param name - the rule name
   * @param fn - returns the value, or `undefined` when the clause does not apply
   * @returns this module, with the rule's result type added to the registry
   */
  complete<N extends string, X>(
    name: N,
    fn: CompleteFn<I, D, R, X>,
  ): Module<P, I, D, Add<R, P, N, X>> {
    this.put(name, new CompleteRule(name, fn));
    return this as unknown as Module<P, I, D, Add<R, P, N, X>>;
  }

  /**
   * Add a `set` clause: yields members that are unioned across all clauses of the
   * rule into a single array result.
   *
   * @param name - the rule name
   * @param fn - yields zero or more set members
   * @returns this module, with the rule typed as an array in the registry
   */
  set<N extends string, X>(name: N, fn: SetFn<I, D, R, X>): Module<P, I, D, Add<R, P, N, X[]>> {
    this.put(name, new SetRule(name, fn));
    return this as unknown as Module<P, I, D, Add<R, P, N, X[]>>;
  }

  /**
   * Add an `object` clause: yields `[key, value]` entries merged across clauses
   * into a single object result.
   *
   * @param name - the rule name
   * @param fn - yields `[key, value]` entries
   * @returns this module, with the rule typed as an object in the registry
   */
  object<N extends string, V>(
    name: N,
    fn: ObjectFn<I, D, R, V>,
  ): Module<P, I, D, Add<R, P, N, { [k: string]: V }>> {
    this.put(name, new ObjectRule(name, fn));
    return this as unknown as Module<P, I, D, Add<R, P, N, { [k: string]: V }>>;
  }

  /**
   * Register a function rule whose arguments and return value are validated and
   * typed by Standard Schemas. Function rules are invoked via `ctx.call`, not
   * queried directly.
   *
   * @param name - the rule name
   * @param schemas - per-argument (`args`) and `output` Standard Schemas
   * @param fn - the function body, receiving `ctx` plus the schema-typed arguments
   * @returns this module, with the rule typed as a callable in the registry
   */
  func<
    N extends string,
    const Args extends ReadonlyArray<StandardSchemaV1>,
    Out extends StandardSchemaV1,
  >(
    name: N,
    schemas: { args: Args; output: Out },
    fn: FuncFn<I, D, R, ArgsOut<Args>, StandardSchemaV1.InferOutput<Out>>,
  ): Module<P, I, D, Add<R, P, N, (...args: ArgsOut<Args>) => StandardSchemaV1.InferOutput<Out>>>;
  /**
   * Register a function rule with no schemas; its argument and return types are
   * taken directly from `fn`. Invoke it via `ctx.call`.
   *
   * @param name - the rule name
   * @param fn - the function body, receiving `ctx` plus arguments
   * @returns this module, with the rule typed as a callable in the registry
   */
  func<N extends string, Args extends readonly unknown[], Out>(
    name: N,
    fn: FuncFn<I, D, R, Args, Out>,
  ): Module<P, I, D, Add<R, P, N, (...args: Args) => Out>>;
  func(
    name: string,
    a:
      | FuncFn<I, D, R, readonly unknown[], unknown>
      | { args: ReadonlyArray<StandardSchemaV1>; output: StandardSchemaV1 },
    b?: FuncFn<I, D, R, readonly unknown[], unknown>,
  ): Module<P, I, D, any> {
    if (typeof a === "function") {
      this.put(name, new FuncRule(name, a as FuncFn<I, D, R, unknown[], unknown>));
    } else {
      this.put(
        name,
        new FuncRule(name, b! as FuncFn<I, D, R, unknown[], unknown>, a satisfies FuncSchemas),
      );
    }
    return this as unknown as Module<P, I, D, any>;
  }

  /**
   * Sugar for a `complete` clause that yields `true` when `pred(ctx)` holds and
   * is otherwise undefined — handy for boolean allow/deny rules.
   *
   * @param name - the rule name
   * @param pred - condition tested against the context
   * @returns this module, with the rule typed as `true` in the registry
   */
  when<N extends string>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
  ): Module<P, I, D, Add<R, P, N, true>>;
  /**
   * Sugar for a `complete` clause that yields `value` when `pred(ctx)` holds and
   * is otherwise undefined.
   *
   * @param name - the rule name
   * @param pred - condition tested against the context
   * @param value - the value produced when `pred` is true
   * @returns this module, with `value`'s type added to the registry
   */
  when<N extends string, V>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
    value: V,
  ): Module<P, I, D, Add<R, P, N, V>>;
  when(
    name: string,
    pred: (ctx: Context<I, D, R>) => boolean,
    value?: unknown,
  ): Module<P, I, D, any> {
    const v = arguments.length >= 3 ? value : true;
    this.put(
      name,
      new CompleteRule<I, D, R, unknown>(name, (ctx) => (pred(ctx) ? (v as unknown) : undefined)),
    );
    return this as unknown as Module<P, I, D, any>;
  }

  /**
   * Sugar for a `set` clause that contributes `value` to the rule's set when
   * `pred(ctx)` holds.
   *
   * @param name - the rule name
   * @param pred - condition tested against the context
   * @param value - the member added when `pred` is true
   * @returns this module, with the rule typed as an array in the registry
   */
  contains<N extends string, V>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
    value: V,
  ): Module<P, I, D, Add<R, P, N, V[]>> {
    this.put(
      name,
      new SetRule<I, D, R, V>(name, function* (ctx) {
        if (pred(ctx)) yield value;
      }),
    );
    return this as unknown as Module<P, I, D, Add<R, P, N, V[]>>;
  }

  getRules(name: string): readonly Rule[] | undefined {
    return this.rules.get(name);
  }

  getDefault(name: string): unknown {
    return this.defaults.get(name);
  }

  hasDefault(name: string): boolean {
    return this.defaults.has(name);
  }

  ruleNames(): readonly string[] {
    return [...this.rules.keys()];
  }

  private put(name: string, rule: Rule): void {
    const existing = this.rules.get(name);
    if (!existing) {
      this.rules.set(name, [rule]);
      return;
    }
    const firstKind = existing[0]!.kind;
    if (firstKind !== rule.kind) {
      throw new RuleKindMismatchError(name, firstKind, rule.kind);
    }
    if (rule.kind === "func") {
      throw new RuleKindMismatchError(name, "func", "func (duplicate)");
    }
    existing.push(rule);
  }
}

/**
 * Package root segments that are forbidden because they collide with built-in
 * members of `ctx` / `engine` (which are exposed through the same proxy tree).
 * {@link module} rejects any package whose first segment is in this set.
 *
 * The set is exactly the real instance members reachable on a `ctx` object
 * (`input`, `data`, `store`, `call`) or an `Engine` (`add`, `put`, `query`,
 * `store`, plus the private `modules` field) — a package sharing one of those
 * names would be silently shadowed by the member instead of routing through the
 * proxy. `constructor` is included too: it is reachable on both proxy targets
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
  // Engine members
  "add",
  "put",
  "query",
  "modules",
  // reachable via the prototype chain on both proxy targets; also a pollution sink
  "constructor",
]);

/**
 * Create a {@link Module} under `packageName`, capturing the name as a literal type
 * for path inference and wiring up optional `input`/`data` validation schemas.
 *
 * @param packageName - dotted package name (e.g. `"authz.http"`)
 * @param schemas - optional Standard Schemas validating the `input` and `data` documents
 * @returns a fresh module to chain rule builders onto
 * @throws {Error} if the package's root segment is {@link RESERVED}
 *
 * @example
 * ```ts
 * const authz = module("authz")
 *   .when("allow", (ctx) => ctx.input.role === "admin");
 * ```
 */
export function module<const P extends string, I = unknown, D = unknown>(
  packageName: P,
  schemas?: {
    input?: StandardSchemaV1<unknown, I>;
    data?: StandardSchemaV1<unknown, D>;
  },
): Module<P, I, D, {}> {
  const root = packageName.split(".")[0]!;
  if (RESERVED.has(root)) {
    throw new Error(
      `package root "${root}" is reserved (collides with ctx/engine members: ${[...RESERVED].join(", ")})`,
    );
  }
  return new Module(packageName, schemas);
}
