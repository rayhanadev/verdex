import { Bundle } from "./bundle.ts";
import { DuplicatePackageError } from "./errors.ts";
import { Evaluator } from "./evaluator.ts";
import { Module, RESERVED } from "./module.ts";
import { isReservedMetaProp, makePackageProxy, type Tree } from "./proxy.ts";
import { Store } from "./store.ts";
import type { Decision, Path, QueryOptions, Registry, RuleEntries, RuleKeys } from "./types.ts";

/**
 * The runtime implementation behind the {@link Engine} type. Exposed publicly as
 * the `Engine` constructor; the instance is wrapped in a `Proxy` so that, beyond
 * its real methods, any package-path access becomes a typed callable that routes
 * to {@link EngineImpl.query}.
 * @internal
 */
class EngineImpl<R extends Registry = {}> {
  private readonly modules: Module<any, any, any, any>[] = [];
  /** The data document shared by every rule evaluated by this engine. */
  readonly store: Store = new Store();

  constructor() {
    // The instance is wrapped in a Proxy so unknown property accesses fall
    // through to a callable package-path proxy that routes to .query().
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
        if (prop in target || RESERVED.has(prop as string)) {
          const own = Reflect.get(target, prop, target);
          // Bind methods to the receiver (the Proxy) so `return this` preserves it.
          return typeof own === "function" ? own.bind(receiver) : own;
        }
        // Reserved meta-props (then/catch/finally/toJSON/toString) on a
        // non-existent property must not become a package path — otherwise
        // `await engine` sees a callable `.then` and JSON.stringify recurses.
        if (isReservedMetaProp(prop)) return undefined;
        return makePackageProxy([prop as string], (path, args) =>
          target.query(path as never, (args[0] as QueryOptions | undefined) ?? {}),
        );
      },
    }) as Engine<R>;
  }

  /**
   * Register a {@link Module}'s rules with the engine.
   *
   * @param m - the module to add
   * @returns the engine, with the module's rule paths folded into its registry
   * @throws {DuplicatePackageError} if a package name is already registered on this engine
   */
  add<R2 extends Registry>(m: Module<any, any, any, R2>): Engine<R & R2>;
  /**
   * Register every module in a {@link Bundle} and merge its seed `data` into the store.
   *
   * @param b - the bundle to add
   * @returns the engine, with the bundle's rule paths folded into its registry
   * @throws {DuplicatePackageError} if a package name is already registered on this engine
   */
  add<R2 extends Registry>(b: Bundle<R2>): Engine<R & R2>;
  add(x: Module<any, any, any, any> | Bundle<any>): Engine<Registry> {
    const incoming = x instanceof Bundle ? x.modules : [x];
    // Validate the whole add before mutating anything, so a rejected add leaves
    // the engine untouched. Package names must be unique per engine: clauses for
    // the same rule only combine within one Module, so two modules sharing a
    // package name would silently fail to merge. Duplicates within the incoming
    // bundle are caught by the same `seen` set.
    const seen = new Set(this.modules.map((m) => m.package.name));
    for (const m of incoming) {
      const name = m.package.name;
      if (seen.has(name)) throw new DuplicatePackageError(name);
      seen.add(name);
    }
    for (const m of incoming) this.modules.push(m);
    if (x instanceof Bundle && Object.keys(x.data).length > 0) this.store.merge(x.data);
    return this as unknown as Engine<Registry>;
  }

  /**
   * Write `value` into the engine's data {@link Store} at `path`.
   *
   * @param path - dotted string or segment array
   * @param value - the value to store
   * @returns this engine, for chaining
   */
  put(path: Path, value: unknown): this {
    this.store.put(path, value);
    return this;
  }

  /**
   * Evaluate the rule at `path` and return its {@link Decision}. The path is
   * checked against the engine's registry and the result type inferred from it;
   * function-rule paths are excluded (invoke those via `ctx.call`).
   *
   * @param path - a queryable rule path known to the registry
   * @param opts - optional `input` and `with` overrides for this query
   * @returns a `Decision` typed by the rule's registered result type
   * @throws {UnknownRuleError} if no rule exists at `path`
   * @throws {RuleQueryError} if `path` names a function rule
   * @throws {ConflictError} if a complete rule yields conflicting values
   * @throws {ValidationError} if the input or a schema rejects a value
   */
  query<P extends RuleKeys<R>>(path: P, opts?: QueryOptions): Decision<R[P]>;
  /** Untyped fallback used only when no rule paths are known (untyped engines). */
  query<T = unknown>(
    path: [RuleKeys<R>] extends [never] ? string : never,
    opts?: QueryOptions,
  ): Decision<T>;
  query(path: string, opts?: QueryOptions): Decision<unknown> {
    return new Evaluator(this.modules, this.store).query(path, opts);
  }
}

/**
 * A policy engine instance: the {@link EngineImpl} methods (`add`, `put`, `query`,
 * `store`) plus a typed proxy tree, so every rule path in the registry `R` is also
 * reachable as a callable — `engine.authz.allow({ input })` returns the same typed
 * {@link Decision} as `engine.query("authz.allow", { input })`.
 *
 * @typeParam R - the registry of rule paths accumulated from added modules/bundles
 */
export type Engine<R extends Registry = {}> = EngineImpl<R> & Tree<RuleEntries<R>>;

/**
 * Create a new policy engine. Add modules or bundles with `.add()` (which refines
 * the engine's type to know their rule paths), seed data with `.put()`, then
 * evaluate rules via `.query()` or the typed package-path proxy.
 *
 * @example
 * ```ts
 * const authz = module("authz")
 *   .when("allow", (ctx) => ctx.input.role === "admin");
 *
 * const engine = new Engine().add(authz);
 * const decision = engine.query("authz.allow", { input: { role: "admin" } });
 * // decision.defined === true, decision.result === true
 * ```
 */
export const Engine = EngineImpl as unknown as new <R extends Registry = {}>() => Engine<R>;
