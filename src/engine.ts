import { Bundle } from "./bundle.ts";
import { DuplicatePackageError, EvaluationError, PolicyError, RuleQueryError } from "./errors.ts";
import { Evaluator, Recorder, finishTrace, type EngineState } from "./evaluator.ts";
import { Module, RESERVED } from "./module.ts";
import { Policy, type AnyModule, type Resolved } from "./policy.ts";
import { isReservedMetaProp } from "./proxy.ts";
import { freezeTree } from "./snapshot.ts";
import { Store } from "./store.ts";
import type {
  DecideKeys,
  Decision,
  EngineOptions,
  EngineTree,
  EntryAt,
  Evaluation,
  EvaluateArgs,
  EvaluateOptions,
  Explanation,
  Handle,
  Path,
  PathsOf,
  QueryArgs,
  QueryOptions,
  Registry,
  ResultOf,
  RuleInfo,
  RuleKeys,
} from "./types.ts";

type Untyped<R extends Registry> = [RuleKeys<R>] extends [never] ? string : never;
type KnownPaths<R extends Registry> = [PathsOf<R>] extends [never] ? string : PathsOf<R>;

/** Internal per-engine state, kept under a symbol key so it never shadows a package root. */
interface Internal extends EngineState {
  readonly options: Readonly<EngineOptions>;
  /** The engine's Proxy, returned by `put` for chaining. */
  self: unknown;
  /** Engine methods bound once (lazily), so property access does not allocate. */
  bound: Map<string, Function> | undefined;
  /** Cached proxy nodes for known package roots (lazily created). */
  roots: Map<string, unknown> | undefined;
}

const STATE: unique symbol = Symbol("verdex.engine");
const EMPTY: QueryOptions = Object.freeze({});
const NO_OPTIONS: Readonly<EngineOptions> = Object.freeze({});
const NO_MODULES = new Policy([]);
const HANDLE_METHODS: ReadonlySet<string> = new Set(["evaluate", "decide", "explain"]);

function internal(engine: object): Internal {
  return (engine as { [STATE]: Internal })[STATE];
}

// `add()` / `withData()` hand the next engine's policy and store to the constructor
// through this slot, so the public constructor keeps its `(options?)` signature.
let pendingInit: { policy: Policy; store: Store } | undefined;

function createEngine(policy: Policy, store: Store, options: EngineOptions): Engine<any> {
  pendingInit = { policy, store };
  return new EngineImpl(options) as unknown as Engine<any>;
}

function runQuery(st: Internal, r: Resolved, opts: QueryOptions | undefined): Decision {
  return new Evaluator(st, opts ?? EMPTY).run(r);
}

function runDecide(st: Internal, r: Resolved, opts: QueryOptions | undefined): unknown {
  const d = runQuery(st, r, opts);
  if (!d.defined) {
    throw new RuleQueryError(
      `rule "${r.path}" produced no value; decide() needs a rule with a default (or a set/object rule)`,
    );
  }
  return d.result;
}

function runExplain(st: Internal, r: Resolved, opts: QueryOptions | undefined): Explanation {
  const rec = new Recorder();
  const decision = new Evaluator(st, opts ?? EMPTY, rec).run(r);
  return { decision, ...finishTrace(r, rec, st.policy, true) };
}

function runEvaluate(
  st: Internal,
  path: string,
  resolved: Resolved | undefined,
  opts: EvaluateOptions | undefined,
): Evaluation {
  const o = opts ?? EMPTY;
  const rec = (o as EvaluateOptions).trace ? new Recorder() : undefined;
  let r = resolved;
  let ev: Evaluator | undefined;
  try {
    r ??= st.policy.resolve(path);
    ev = new Evaluator(st, o, rec);
    const decision = ev.run(r);
    return rec
      ? { ok: true, decision, trace: finishTrace(r, rec, st.policy, true) }
      : { ok: true, decision };
  } catch (cause) {
    const rethrow = (o as EvaluateOptions).rethrow ?? st.options.rethrow;
    if (rethrow !== undefined && rethrow(cause)) throw cause;
    const error =
      cause instanceof PolicyError
        ? cause
        : ev
          ? ev.wrap(cause, path)
          : new EvaluationError({ path, cause });
    return rec && r
      ? { ok: false, error, trace: finishTrace(r, rec, st.policy, false) }
      : { ok: false, error };
  }
}

// A compiled rule: the path is resolved once, and each call goes straight to the
// evaluator with no proxy hops.
function makeHandle(st: Internal, r: Resolved): Handle<any> {
  const handle = (opts?: QueryOptions) => runQuery(st, r, opts);
  return Object.freeze(
    Object.assign(handle, {
      evaluate: (opts?: EvaluateOptions) => runEvaluate(st, r.path, r, opts),
      explain: (opts?: QueryOptions) => runExplain(st, r, opts),
      decide: (opts?: QueryOptions) => runDecide(st, r, opts),
    }),
  ) as unknown as Handle<any>;
}

// ---------------------------------------------------------------------------
// The engine proxy tree: `engine.pkg.rule(opts)`. Nodes for known paths are cached
// per engine, so a property hop does not allocate; unknown paths get fresh,
// uncached nodes that fail at call time, as in 0.2.
// ---------------------------------------------------------------------------

const NODE: unique symbol = Symbol("verdex.node");

interface NodeState {
  readonly st: Internal;
  readonly segments: readonly string[];
  readonly path: string;
  readonly resolved: Resolved | undefined;
  children: Map<string, unknown> | undefined;
  handle: Handle<any> | undefined;
}

type NodeTarget = (() => void) & { [NODE]: NodeState };

const NODE_HANDLER: ProxyHandler<NodeTarget> = {
  apply(target, _thisArg, args: unknown[]) {
    return dispatchNode(target[NODE], args[0] as EvaluateOptions | undefined);
  },
  get(target, prop) {
    const s = target[NODE];
    // Any symbol is a runtime hook, never a package path.
    if (typeof prop === "symbol") return undefined;
    // `toString` keeps its proxy-label behavior; every other reserved meta-prop
    // returns undefined instead of recursing.
    if (prop === "toString") return () => `[Proxy ${s.path}]`;
    if (isReservedMetaProp(prop)) return undefined;
    if (s.resolved !== undefined && s.resolved.kind !== "func" && HANDLE_METHODS.has(prop)) {
      return (s.handle ??= makeHandle(s.st, s.resolved))[prop as "evaluate"];
    }
    const hit = s.children?.get(prop);
    if (hit !== undefined) return hit;
    return makeNode(s.st, [...s.segments, prop], (s.children ??= new Map()));
  },
};

function makeNode(st: Internal, segments: readonly string[], cache: Map<string, unknown>): unknown {
  const path = segments.join(".");
  const target = (() => {}) as NodeTarget;
  target[NODE] = {
    st,
    segments,
    path,
    resolved: st.policy.lookup(path),
    children: undefined,
    handle: undefined,
  };
  const node = new Proxy(target, NODE_HANDLER);
  // Only known paths are cached, so arbitrary property names cannot grow memory.
  if (st.policy.isKnown(path)) cache.set(segments[segments.length - 1]!, node);
  return node;
}

function dispatchNode(s: NodeState, opts: EvaluateOptions | undefined): unknown {
  if (s.resolved !== undefined) return runQuery(s.st, s.resolved, opts);
  // `engine.<unknown path>.evaluate(opts)` is the evaluate form of the prefix: it
  // must report the unknown prefix rather than query "<prefix>.evaluate".
  const n = s.segments.length;
  const last = s.segments[n - 1]!;
  if (n > 1 && HANDLE_METHODS.has(last)) {
    const prefix = s.segments.slice(0, -1).join(".");
    if (last === "evaluate") return runEvaluate(s.st, prefix, undefined, opts);
    const r = s.st.policy.resolve(prefix);
    return last === "decide" ? runDecide(s.st, r, opts) : runExplain(s.st, r, opts);
  }
  return runQuery(s.st, s.st.policy.resolve(s.path), opts);
}

const ENGINE_HANDLER: ProxyHandler<EngineImpl<any>> = {
  get(target, prop, receiver) {
    if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
    if (prop in target || RESERVED.has(prop)) {
      const own = Reflect.get(target, prop, target);
      if (typeof own !== "function") return own;
      // Bind methods once to the real instance; `put` returns the proxy itself.
      const st = internal(target);
      const cached = st.bound?.get(prop);
      if (cached !== undefined) return cached;
      const bound: Function = (own as Function).bind(target);
      (st.bound ??= new Map()).set(prop, bound);
      return bound;
    }
    // Reserved meta-props (then/catch/finally/toJSON/toString) on a non-existent
    // property must not become a package path — otherwise `await engine` sees a
    // callable `.then` and JSON.stringify recurses.
    if (isReservedMetaProp(prop)) return undefined;
    const st = internal(target);
    return st.roots?.get(prop) ?? makeNode(st, [prop], (st.roots ??= new Map()));
  },
};

/**
 * The runtime implementation behind the {@link Engine} type. Exposed publicly as
 * the `Engine` constructor; the instance is wrapped in a `Proxy` so that, beyond
 * its real methods, any package-path access becomes a typed callable that routes
 * to a query.
 *
 * Engines are immutable with respect to their modules: `add()` and `withData()`
 * return new engines and leave the original untouched. Only the engine's own
 * {@link Store} is writable, through `put`.
 * @internal
 */
class EngineImpl<R extends Registry = never> {
  private readonly modules: readonly AnyModule[];
  /** The data document shared by every rule evaluated by this engine. */
  readonly store: Store;

  constructor(options?: EngineOptions) {
    const init = pendingInit;
    pendingInit = undefined;
    const policy = init?.policy ?? NO_MODULES;
    // Derived engines pass the parent's (already frozen) options object through.
    const opts: Readonly<EngineOptions> =
      options === undefined
        ? NO_OPTIONS
        : Object.isFrozen(options)
          ? options
          : Object.freeze({ ...options });
    this.modules = policy.modules;
    this.store = init?.store ?? new Store();
    const st: Internal = {
      policy,
      store: this.store,
      unsafe: opts.unsafeKeys === "drop" ? "drop" : "reject",
      options: opts,
      self: undefined,
      bound: undefined,
      roots: undefined,
    };
    // A symbol key is invisible to `prop in target` checks for package roots.
    (this as unknown as { [STATE]: Internal })[STATE] = st;
    // The instance is wrapped in a Proxy so unknown property accesses fall
    // through to a callable package-path proxy that routes to a query.
    const proxy = new Proxy(this, ENGINE_HANDLER);
    st.self = proxy;
    return proxy;
  }

  /**
   * Return a **new** engine with a {@link Module}'s rules added. This engine is
   * not changed. The new engine starts with a copy of this engine's data.
   *
   * @param m - the module to add
   * @returns a new engine, with the module's rule paths folded into its registry
   * @throws {DuplicatePackageError} if a package name is already registered on this engine
   */
  add<R2 extends Registry>(m: Module<any, any, any, R2, any, any>): Engine<R | R2>;
  /**
   * Return a **new** engine with every module in a {@link Bundle} added and its
   * seed `data` merged into the new engine's store. This engine is not changed.
   *
   * @param b - the bundle to add
   * @returns a new engine, with the bundle's rule paths folded into its registry
   * @throws {DuplicatePackageError} if a package name is already registered on this engine
   */
  add<R2 extends Registry>(b: Bundle<R2>): Engine<R | R2>;
  add(x: Module<any, any, any, any, any, any> | Bundle<any>): unknown {
    const st = internal(this);
    const incoming = x instanceof Bundle ? x.modules : [x];
    // Package names must be unique per engine: clauses for the same rule only
    // combine within one Module, so two modules sharing a package name would
    // silently fail to merge. Duplicates within the incoming bundle are caught by
    // the same `seen` set.
    const seen = new Set(this.modules.map((m) => m.package.name));
    for (const m of incoming) {
      const name = m.package.name;
      if (seen.has(name)) throw new DuplicatePackageError(name);
      seen.add(name);
    }
    const store = st.store.fork();
    if (x instanceof Bundle && Object.keys(x.data).length > 0) store.merge(x.data);
    return createEngine(new Policy([...this.modules, ...incoming]), store, st.options);
  }

  /**
   * Write `value` into this engine's data {@link Store} at `path`. The store keeps
   * a deep-frozen copy of `value`. Avoid per-request facts here — a shared engine's
   * store is shared by every request; pass per-request facts as `input` or as
   * per-query `data`, or use {@link withData}.
   *
   * @param path - dotted string or segment array
   * @param value - the value to store
   * @returns this engine, for chaining
   */
  put(path: Path, value: unknown): this {
    this.store.put(path, value);
    return internal(this).self as this;
  }

  /**
   * Return a **new** engine with the same modules whose data document is `doc`
   * (deep-frozen; a deep-frozen `doc` is used as-is). This engine is not changed.
   * Use it to bind per-request or per-tenant data without sharing mutable state.
   *
   * @param doc - the data document (a plain object)
   * @returns a new engine with the same registry
   * @throws {UnsafeKeyError} if `doc` contains an unsafe key (unless `unsafeKeys: "drop"`)
   * @throws {TypeError} if `doc` is not an object
   */
  withData(doc: object): Engine<R> {
    const st = internal(this);
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new TypeError("withData() needs a plain object document");
    }
    const proto = Object.getPrototypeOf(doc);
    const plain = proto === Object.prototype || proto === null ? doc : { ...doc };
    const root = freezeTree(plain, st.unsafe, "withData document", true);
    return createEngine(st.policy, Store.from(root, 0), st.options) as Engine<R>;
  }

  /**
   * Evaluate the rule at `path` and return its {@link Decision}. The path, the
   * input shape and the result type are all checked against the registry.
   *
   * @param path - a queryable rule path known to the registry
   * @param opts - `input`, per-query `data`, and `with` overrides for this query
   * @returns a `Decision` typed by the rule's registered result type
   * @throws {UnknownRuleError} if no rule exists at `path`
   * @throws {RuleQueryError} if `path` names a function rule
   * @throws {ConflictError} if a complete rule yields conflicting values
   * @throws {ValidationError} if the input or a schema rejects a value
   * @throws {UnsafeKeyError} if a query document contains an unsafe key
   */
  query<P extends RuleKeys<R>>(
    path: P,
    ...opts: QueryArgs<EntryAt<R, P>>
  ): Decision<ResultOf<EntryAt<R, P>>>;
  /** Untyped fallback used only when no rule paths are known (untyped engines). */
  query<T = unknown>(path: Untyped<R>, opts?: QueryOptions): Decision<T>;
  query(path: string, opts?: QueryOptions): Decision<unknown> {
    const st = internal(this);
    return runQuery(st, st.policy.resolve(path), opts);
  }

  /**
   * Evaluate the rule at `path` without throwing. A failure — validation,
   * conflict, unknown path, unsafe key, or an exception from a rule body — comes
   * back as `{ ok: false, error }`, where a non-policy throw is wrapped in an
   * {@link EvaluationError}. A thrown value for which `rethrow` returns `true`
   * propagates unchanged.
   *
   * @param path - a queryable rule path known to the registry
   * @param opts - query options plus `rethrow` and `trace`
   * @returns `{ ok: true, decision }` or `{ ok: false, error }`
   */
  evaluate<P extends RuleKeys<R>>(
    path: P,
    ...opts: EvaluateArgs<EntryAt<R, P>>
  ): Evaluation<ResultOf<EntryAt<R, P>>>;
  /** Untyped fallback used only when no rule paths are known (untyped engines). */
  evaluate<T = unknown>(path: Untyped<R>, opts?: EvaluateOptions): Evaluation<T>;
  evaluate(path: string, opts?: EvaluateOptions): Evaluation<unknown> {
    return runEvaluate(internal(this), path, undefined, opts);
  }

  /**
   * Evaluate an always-defined rule (one with a `default`, or a `set` / `object`
   * rule) and return its result directly. Querying any other rule is a compile
   * error.
   *
   * @param path - a rule path whose rule is always defined
   * @param opts - query options
   * @returns the rule's result
   * @throws the same errors as {@link query}; {@link RuleQueryError} if the rule
   *   produced no value (only reachable through untyped paths)
   */
  decide<P extends DecideKeys<R>>(
    path: P,
    ...opts: QueryArgs<EntryAt<R, P>>
  ): ResultOf<EntryAt<R, P>>;
  /** Untyped fallback used only when no rule paths are known (untyped engines). */
  decide<T = unknown>(path: Untyped<R>, opts?: QueryOptions): T;
  decide(path: string, opts?: QueryOptions): unknown {
    const st = internal(this);
    return runDecide(st, st.policy.resolve(path), opts);
  }

  /**
   * Evaluate the rule at `path` and return the decision together with a
   * {@link Trace}: what each clause did (by `id` when declared), the function
   * calls and rule references made, the policy fingerprint and the duration. The
   * normal query path records nothing; only `explain()` and
   * `evaluate({ trace: true })` pay for tracing.
   *
   * @param path - a queryable rule path known to the registry
   * @param opts - query options
   * @returns the decision plus its trace
   * @throws the same errors as {@link query}
   */
  explain<P extends RuleKeys<R>>(
    path: P,
    ...opts: QueryArgs<EntryAt<R, P>>
  ): Explanation<ResultOf<EntryAt<R, P>>>;
  /** Untyped fallback used only when no rule paths are known (untyped engines). */
  explain<T = unknown>(path: Untyped<R>, opts?: QueryOptions): Explanation<T>;
  explain(path: string, opts?: QueryOptions): Explanation<unknown> {
    const st = internal(this);
    return runExplain(st, st.policy.resolve(path), opts);
  }

  /**
   * Resolve `path` once and return a direct callable for it, with `evaluate`,
   * `explain` and (for always-defined rules) `decide` members. Calls skip path
   * resolution and the proxy hops, which makes this the fastest way to run one
   * rule many times. The handle reads this engine's store at call time.
   *
   * @param path - a queryable rule path known to the registry
   * @returns a typed handle for the rule
   * @throws {UnknownRuleError} if no rule exists at `path`
   * @throws {RuleQueryError} if `path` names a function rule
   */
  compile<P extends RuleKeys<R>>(path: P): Handle<EntryAt<R, P>>;
  /** Untyped fallback used only when no rule paths are known (untyped engines). */
  compile(path: Untyped<R>): Handle<unknown>;
  compile(path: string): Handle<unknown> {
    const st = internal(this);
    const r = st.policy.resolve(path);
    if (r.kind === "func") {
      throw new RuleQueryError(`cannot compile function rule "${path}"; call it via ctx.call`);
    }
    return makeHandle(st, r);
  }

  /**
   * List every rule this engine knows, with its kind, default, clause ids and
   * documentation metadata — for generated docs, access matrices and audits.
   *
   * @returns one frozen record per rule, in module-add then declaration order
   */
  rules(): readonly RuleInfo<KnownPaths<R>>[] {
    return internal(this).policy.rules() as readonly RuleInfo<KnownPaths<R>>[];
  }

  /**
   * A stable hash of this engine's policy — every module's structure, rule
   * bodies, defaults and version — independent of the order modules were added
   * and of the data document. Use it to record which policy made a decision.
   *
   * @returns a hex string; not a cryptographic digest
   */
  fingerprint(): string {
    return internal(this).policy.fingerprint();
  }
}

/**
 * A policy engine instance: the {@link EngineImpl} methods (`add`, `put`,
 * `query`, `evaluate`, `decide`, `explain`, `compile`, `withData`, `rules`,
 * `fingerprint`, `store`) plus a typed proxy tree, so every rule path in the
 * registry `R` is also reachable as a callable — `engine.authz.allow({ input })`
 * returns the same typed {@link Decision} as `engine.query("authz.allow", { input })`,
 * and `engine.authz.allow.evaluate(...)` / `.explain(...)` / `.decide(...)` are
 * the matching non-throwing, explaining and direct forms.
 *
 * @typeParam R - the registry of rule paths accumulated from added modules/bundles
 */
export type Engine<R extends Registry = never> = EngineImpl<R> & EngineTree<R, RuleKeys<R>>;

/**
 * Create a new policy engine. Add modules or bundles with `.add()` (which returns
 * a new engine whose type knows their rule paths), then evaluate rules via
 * `.query()`, `.evaluate()`, `.decide()`, `.explain()` or the typed package-path
 * proxy.
 *
 * @param options - `unsafeKeys` (`"reject"` by default, or `"drop"`) and a default
 *   `rethrow` predicate for `evaluate()`
 *
 * @example
 * ```ts
 * const authz = module("authz")
 *   .default("allow", false)
 *   .when("allow", (ctx) => ctx.input.role === "admin");
 *
 * const engine = new Engine().add(authz);
 * engine.query("authz.allow", { input: { role: "admin" } }); // { defined: true, result: true }
 * engine.decide("authz.allow", { input: { role: "guest" } }); // false
 * ```
 */
export const Engine = EngineImpl as unknown as new <R extends Registry = never>(
  options?: EngineOptions,
) => Engine<R>;
