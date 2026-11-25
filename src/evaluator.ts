import { FuncRule, type CompleteRule, type ObjectRule, type Rule, type SetRule } from "./rule.ts";
import type { Store } from "./store.ts";
import {
  ConflictError,
  CycleError,
  EvaluationError,
  OverrideError,
  PolicyError,
  RuleQueryError,
  UnsafeKeyError,
  validate,
} from "./errors.ts";
import { policyRef, type AnyModule, type Policy, type Resolved } from "./policy.ts";
import { isReservedMetaProp, makePackageProxy } from "./proxy.ts";
import { freezeTree, isVetted } from "./snapshot.ts";
import type { StandardSchemaV1 } from "./schema.ts";
import type {
  CallTrace,
  ClauseTrace,
  Context,
  Decision,
  Override,
  QueryOptions,
  Trace,
} from "./types.ts";
import { assertSafeKey, splitPath, UNSAFE_KEYS } from "./types.ts";

/**
 * What a query needs from its engine.
 * @internal
 */
export interface EngineState {
  readonly policy: Policy;
  readonly store: Store;
  readonly unsafe: "reject" | "drop";
}

const hasOwn = Object.prototype.hasOwnProperty;
const UNDEFINED: Decision = Object.freeze({ defined: false });

const clock: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

// Validated data documents, cached per (document, schema) for vetted documents
// only: a vetted document is deep-frozen, so it cannot change under the cache. A
// store write produces a new root object, which invalidates naturally.
const validatedData = {
  reject: new WeakMap<object, WeakMap<object, { value: unknown }>>(),
  drop: new WeakMap<object, WeakMap<object, { value: unknown }>>(),
};

function validateData(
  schema: StandardSchemaV1,
  doc: unknown,
  subject: string,
  onUnsafe: "reject" | "drop",
): unknown {
  // Always returns a frozen snapshot; only vetted documents are cached.
  if (!isVetted(doc)) return freezeTree(validate(schema, doc, subject), onUnsafe, subject, false);
  const byDoc = validatedData[onUnsafe];
  let bySchema = byDoc.get(doc as object);
  const hit = bySchema?.get(schema);
  if (hit !== undefined) return hit.value;
  const value = freezeTree(validate(schema, doc, subject), onUnsafe, subject, true);
  if (bySchema === undefined) {
    bySchema = new WeakMap();
    byDoc.set(doc as object, bySchema);
  }
  bySchema.set(schema, { value });
  return value;
}

/** Collects what `explain()` / `evaluate({ trace: true })` report. @internal */
export class Recorder {
  readonly clauses: ClauseTrace[] = [];
  readonly calls: CallTrace[] = [];
  readonly modules = new Set<AnyModule>();
  readonly start = clock();
}

/**
 * Turn a recorder into the public {@link Trace}.
 *
 * @param ok - whether the query produced a decision (a failed query is never "defaulted")
 * @internal
 */
export function finishTrace(r: Resolved, rec: Recorder, policy: Policy, ok: boolean): Trace {
  return {
    path: r.path,
    kind: r.kind,
    clauses: rec.clauses,
    defaulted: ok && r.kind === "complete" && r.hasDefault && !rec.clauses.some((c) => c.matched),
    calls: rec.calls,
    policy: { fingerprint: policy.fingerprint(), modules: [...rec.modules].map(policyRef) },
    durationMs: clock() - rec.start,
  };
}

interface FuncMemo {
  readonly args: readonly unknown[];
  readonly value: unknown;
}

interface CtxTarget {
  readonly input: unknown;
  readonly data: unknown;
  readonly [DISPATCH]: (path: string, args: unknown[]) => unknown;
}

// The package-path dispatcher of a ctx, kept under a non-enumerable symbol key. It
// grants nothing beyond what the ctx proxy already offers (function calls and rule
// references), so it needs no further hiding.
const DISPATCH: unique symbol = Symbol("verdex.dispatch");

const CTX_HANDLER: ProxyHandler<CtxTarget> = {
  get(target, prop) {
    // Own-property only: the real ctx members (input/data/store/call/query) are own
    // keys. Inherited Object.prototype members (constructor/hasOwnProperty/
    // valueOf/…) fall through to the package-path logic below rather than
    // silently shadow a same-named package — `module()` already rejects the
    // names that would actually resolve to a member (see RESERVED).
    if (typeof prop === "string" && hasOwn.call(target, prop)) {
      return (target as unknown as Record<string, unknown>)[prop];
    }
    if (typeof prop === "symbol") return Reflect.get(target, prop);
    // Reserved meta-props (then/catch/finally/toJSON/toString) on a non-existent
    // property must not become a package path — otherwise `await ctx` sees a
    // callable `.then` and JSON.stringify/inspection recurses.
    if (isReservedMetaProp(prop)) return undefined;
    return makePackageProxy([prop], target[DISPATCH]);
  },
};

/**
 * Evaluates one query. An instance lives for exactly one query: it caches the
 * per-module contexts, memoizes rule references and function calls, detects
 * reference cycles, and remembers where a thrown value came from.
 * @internal
 */
export class Evaluator {
  private root: Resolved | undefined;
  // The first module's context lives in fields; most queries touch one module.
  private ctxModule: AnyModule | undefined;
  private ctx: Context | undefined;
  private contexts: Map<AnyModule, Context> | undefined;
  private doc: unknown;
  private docReady = false;
  private plainInput: unknown;
  private plainInputReady = false;
  private refs: Map<string, Decision> | undefined;
  private funcs: Map<string, FuncMemo[]> | undefined;
  private stack: string[] | undefined;
  private dispatcher: ((path: string, args: unknown[]) => unknown) | undefined;
  // The rule clause that is running, for EvaluationError attribution.
  private rule: Resolved | undefined;
  private clause = -1;
  private noted = false;
  private thrown: unknown;
  private siteRule: Resolved | undefined;
  private siteClause = -1;
  // Where clause traces go while tracing (the queried rule, or a referenced rule).
  private sink: ClauseTrace[] | undefined;

  constructor(
    private readonly state: EngineState,
    private readonly opts: QueryOptions,
    private readonly rec?: Recorder,
  ) {}

  /** Evaluate the resolved rule as the query's root. */
  run(r: Resolved): Decision {
    if (r.kind === "func") {
      throw new RuleQueryError(
        `cannot query function rule "${r.path}" directly; call it via ctx.call`,
      );
    }
    this.root = r;
    if (this.rec) this.sink = this.rec.clauses;
    return this.evalRule(r);
  }

  /**
   * Wrap a value thrown out of {@link run} for `evaluate()`: policy errors pass
   * through; anything else becomes an {@link EvaluationError} naming the clause
   * that threw it.
   */
  wrap(cause: unknown, path: string): PolicyError {
    if (cause instanceof PolicyError) return cause;
    this.note(cause);
    const rule = this.siteRule;
    if (rule === undefined) return new EvaluationError({ path, cause });
    const clause = rule.rules[this.siteClause];
    return new EvaluationError({
      path,
      rulePath: rule.path,
      clause:
        this.siteClause < 0 || clause === undefined
          ? undefined
          : clause.id === undefined
            ? { index: this.siteClause }
            : { index: this.siteClause, id: clause.id },
      cause,
    });
  }

  // Remember the innermost site of a thrown value. Nested calls note before their
  // `finally` restores the outer clause; the first note for a value wins.
  private note(e: unknown): void {
    if (this.noted && this.thrown === e) return;
    this.noted = true;
    this.thrown = e;
    this.siteRule = this.rule;
    this.siteClause = this.clause;
  }

  private evalRule(r: Resolved): Decision {
    const ctx = this.contextFor(r.module);
    switch (r.kind) {
      case "set":
        return this.evalSet(r, ctx);
      case "object":
        return this.evalObject(r, ctx);
      default:
        return this.evalComplete(r, ctx);
    }
  }

  private contextFor(m: AnyModule): Context {
    if (this.ctxModule === m) return this.ctx!;
    const other = this.contexts?.get(m);
    if (other !== undefined) return other;
    const ctx = this.makeContext(m);
    if (this.ctxModule === undefined) {
      this.ctxModule = m;
      this.ctx = ctx;
    } else {
      (this.contexts ??= new Map()).set(m, ctx);
    }
    if (this.rec) this.rec.modules.add(m);
    return ctx;
  }

  // The query's base data document: the per-query `data` (snapshotted), or the
  // store's document, which is already a frozen snapshot.
  private document(): unknown {
    if (!this.docReady) {
      const d = this.opts.data;
      this.doc =
        d === undefined
          ? this.state.store.document
          : freezeTree(d, this.state.unsafe, "data", false);
      this.docReady = true;
    }
    return this.doc;
  }

  private makeContext(m: AnyModule): Context {
    const opts = this.opts;
    const onUnsafe = this.state.unsafe;
    const overrides = opts.with;
    const hasOverrides = overrides !== undefined && overrides.length > 0;
    let input: unknown;
    if (m.inputSchema !== undefined) {
      input = validate(m.inputSchema, opts.input, `${m.package.name} input`);
    } else if (!hasOverrides) {
      // Schema-less modules share one snapshot of the raw input per query.
      if (!this.plainInputReady) {
        this.plainInput = freezeTree(opts.input, onUnsafe, "input", false);
        this.plainInputReady = true;
      }
      input = this.plainInput;
    } else {
      input = opts.input;
    }
    let data = this.document();
    if (m.dataSchema !== undefined) {
      data = validateData(m.dataSchema, data, `${m.package.name} data`, onUnsafe);
    }
    if (hasOverrides) {
      const next = applyOverrides(input, data, overrides);
      input = next.input;
      data = next.data;
    }
    // Snapshot + deep-freeze the per-query input/data so a rule body cannot mutate
    // the caller's input or the shared data document. Vetted (already frozen)
    // trees are reused by reference; everything else is copied, so the caller's
    // objects are never frozen. The base document and validated data are already
    // snapshots, so only schema output and override results are frozen here.
    // ctx.store is the store's frozen read-only facade.
    const base = {
      input:
        m.inputSchema === undefined && !hasOverrides
          ? input
          : freezeTree(input, onUnsafe, "input", false),
      data: hasOverrides ? freezeTree(data, onUnsafe, "data", false) : data,
      store: this.state.store.asReadonly(),
      call: (path: string, ...args: unknown[]): unknown =>
        this.callFunc(this.state.policy.resolve(path), args),
      query: (path: string): Decision => this.queryRef(path),
    };
    Object.defineProperty(base, DISPATCH, {
      value: (this.dispatcher ??= (path, args) => this.dispatch(path, args)),
    });
    Object.freeze(base);
    // Wrap in a Proxy so unknown property accesses become typed-callable
    // package paths: ctx.authz.isAdmin(user) → a function call, ctx.authz.allow()
    // → a rule reference.
    return new Proxy(base as typeof base & CtxTarget, CTX_HANDLER) as unknown as Context;
  }

  // ctx.<pkg>.<name>(...args): a function call, or a zero-argument rule reference.
  private dispatch(path: string, args: unknown[]): unknown {
    const r = this.state.policy.resolve(path);
    if (r.kind === "func") return this.callFunc(r, args);
    if (args.length > 0) {
      throw new RuleQueryError(`rule reference "${path}" takes no arguments`);
    }
    const d = this.ref(r);
    return d.defined ? d.result : undefined;
  }

  // ctx.query(path): a rule reference that returns the full Decision.
  private queryRef(path: string): Decision {
    const r = this.state.policy.resolve(path);
    if (r.kind === "func") {
      throw new RuleQueryError(
        `cannot query function rule "${path}" directly; call it via ctx.call`,
      );
    }
    return this.ref(r);
  }

  private ref(r: Resolved): Decision {
    const rec = this.rec;
    const refs = (this.refs ??= new Map());
    const hit = refs.get(r.path);
    if (hit !== undefined) {
      rec?.calls.push({ kind: "rule", path: r.path, args: [], result: hit, cached: true });
      return hit;
    }
    const stack = (this.stack ??= this.root ? [this.root.path] : []);
    const at = stack.indexOf(r.path);
    if (at !== -1) throw new CycleError([...stack.slice(at), r.path]);
    const clauses: ClauseTrace[] | undefined = rec ? [] : undefined;
    const entry = rec
      ? {
          kind: "rule" as const,
          path: r.path,
          args: [],
          result: undefined as unknown,
          cached: false,
          clauses,
        }
      : undefined;
    if (entry) rec!.calls.push(entry);
    const prevRule = this.rule;
    const prevClause = this.clause;
    const prevSink = this.sink;
    this.sink = clauses;
    stack.push(r.path);
    let d: Decision;
    try {
      d = this.evalRule(r);
    } catch (e) {
      this.note(e);
      throw e;
    } finally {
      stack.pop();
      this.rule = prevRule;
      this.clause = prevClause;
      this.sink = prevSink;
    }
    refs.set(r.path, d);
    if (entry) entry.result = d;
    return d;
  }

  private callFunc(r: Resolved, args: unknown[]): unknown {
    const rule = r.rules[0];
    if (!(rule instanceof FuncRule)) {
      throw new RuleQueryError(`"${r.path}" is not a function rule`);
    }
    const memo = (this.funcs ??= new Map());
    let seen = memo.get(r.path);
    if (seen !== undefined) {
      for (const m of seen) {
        if (sameArgs(m.args, args)) {
          this.rec?.calls.push({ kind: "func", path: r.path, args, result: m.value, cached: true });
          return m.value;
        }
      }
    }
    const ctx = this.contextFor(r.module);
    const prevRule = this.rule;
    const prevClause = this.clause;
    this.rule = r;
    this.clause = -1;
    let out: unknown;
    try {
      let callArgs: unknown[] = args;
      if (rule.schemas?.args) {
        callArgs = rule.schemas.args.map((schema, i) =>
          validate(schema, args[i], `${r.path} arg[${i}]`),
        );
      }
      out = (rule.fn as (ctx: Context, ...a: unknown[]) => unknown)(ctx, ...callArgs);
      if (rule.schemas?.output) out = validate(rule.schemas.output, out, `${r.path} output`);
    } catch (e) {
      this.note(e);
      throw e;
    } finally {
      this.rule = prevRule;
      this.clause = prevClause;
    }
    if (seen === undefined) memo.set(r.path, (seen = []));
    seen.push({ args, value: out });
    this.rec?.calls.push({ kind: "func", path: r.path, args, result: out, cached: false });
    return out;
  }

  private evalComplete(r: Resolved, ctx: Context): Decision {
    const rules = r.rules as readonly CompleteRule<unknown, unknown, never, unknown>[];
    const sink = this.sink;
    let first: unknown;
    let count = 0;
    let values: unknown[] | undefined;
    this.rule = r;
    for (let i = 0; i < rules.length; i++) {
      this.clause = i;
      const rule = rules[i]!;
      const v = rule.fn(ctx);
      if (sink !== undefined) sink.push(clauseTrace(rule, i, v !== undefined, v));
      if (v === undefined) continue;
      if (count === 0) first = v;
      else (values ??= [first]).push(v);
      count++;
    }
    if (count === 0) {
      return r.hasDefault ? { defined: true, result: r.defaultValue } : UNDEFINED;
    }
    if (values !== undefined) {
      for (let i = 1; i < values.length; i++) {
        if (!eq(first, values[i])) throw new ConflictError(r.path, values);
      }
    }
    return { defined: true, result: first };
  }

  private evalSet(r: Resolved, ctx: Context): Decision<unknown[]> {
    const rules = r.rules as readonly SetRule<unknown, unknown, never, unknown>[];
    const sink = this.sink;
    const out: unknown[] = [];
    // Primitive members dedupe with a native Set once the result grows past a few
    // members (a linear Object.is scan is cheaper below that); object members fall
    // back to deep equality. -0 is tracked apart because Set treats it as +0,
    // while `eq` (Object.is) keeps them distinct.
    let prims: Set<unknown> | undefined;
    let primCount = 0;
    let objs: unknown[] | undefined;
    let negZero = false;
    this.rule = r;
    for (let i = 0; i < rules.length; i++) {
      this.clause = i;
      const rule = rules[i]!;
      const yielded: unknown[] | undefined = sink ? [] : undefined;
      for (const item of rule.fn(ctx)) {
        yielded?.push(item);
        if (item !== null && typeof item === "object") {
          if (objs === undefined) objs = [];
          else if (includesEq(objs, item)) continue;
          objs.push(item);
        } else if (item === 0 && Object.is(item, -0)) {
          if (negZero) continue;
          negZero = true;
        } else if (prims !== undefined) {
          if (prims.has(item)) continue;
          prims.add(item);
        } else {
          if (includesSame(out, item)) continue;
          if (++primCount >= SMALL_SET) prims = primitiveSet(out, item);
        }
        out.push(item);
      }
      if (sink !== undefined) sink.push(clauseTrace(rule, i, yielded!.length > 0, yielded));
    }
    return { defined: true, result: out };
  }

  private evalObject(r: Resolved, ctx: Context): Decision<{ [k: string]: unknown }> {
    const rules = r.rules as readonly ObjectRule<unknown, unknown, never, unknown>[];
    const sink = this.sink;
    const drop = this.state.unsafe === "drop";
    const out: { [k: string]: unknown } = {};
    this.rule = r;
    for (let i = 0; i < rules.length; i++) {
      this.clause = i;
      const rule = rules[i]!;
      const entries: (readonly [string, unknown])[] | undefined = sink ? [] : undefined;
      for (const entry of rule.fn(ctx)) {
        entries?.push(entry);
        const [k, v] = entry;
        // An unsafe key would replace the result's prototype (`__proto__`) or
        // shadow prototype machinery, so it follows the engine's unsafeKeys policy.
        if (UNSAFE_KEYS.has(k)) {
          if (drop) continue;
          throw new UnsafeKeyError(k, `${r.path} result`);
        }
        // Own-key check: an inherited name such as "toString" is not a prior entry.
        if (hasOwn.call(out, k)) {
          if (!eq(out[k], v)) {
            throw new ConflictError(`${r.path}[${JSON.stringify(k)}]`, [out[k], v]);
          }
        } else {
          out[k] = v;
        }
      }
      if (sink !== undefined) sink.push(clauseTrace(rule, i, entries!.length > 0, entries));
    }
    return { defined: true, result: out };
  }
}

const SMALL_SET = 8;

function primitiveSet(out: readonly unknown[], item: unknown): Set<unknown> {
  const s = new Set<unknown>();
  for (const x of out) if ((x === null || typeof x !== "object") && !Object.is(x, -0)) s.add(x);
  s.add(item);
  return s;
}

function includesSame(list: readonly unknown[], item: unknown): boolean {
  for (let i = 0; i < list.length; i++) if (Object.is(list[i], item)) return true;
  return false;
}

function includesEq(list: readonly unknown[], item: unknown): boolean {
  for (let i = 0; i < list.length; i++) if (eq(list[i], item)) return true;
  return false;
}

function sameArgs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function clauseTrace(rule: Rule, index: number, matched: boolean, value: unknown): ClauseTrace {
  const t: { index: number; id?: string; matched: boolean; value?: unknown } =
    rule.id === undefined ? { index, matched } : { index, id: rule.id, matched };
  if (matched) t.value = value;
  return t;
}

function applyOverrides(
  input: unknown,
  data: unknown,
  overrides: readonly Override[],
): { input: unknown; data: unknown } {
  let nextInput = input;
  let nextData = data;
  for (const o of overrides) {
    const segments = splitPath(o.target);
    const root = segments[0];
    if (root === "input") {
      nextInput = setIn(nextInput, segments.slice(1), o.value);
    } else if (root === "data") {
      nextData = setIn(nextData, segments.slice(1), o.value);
    } else {
      throw new OverrideError(
        `invalid 'with' target "${o.target}": must start with "input" or "data"`,
      );
    }
  }
  return { input: nextInput, data: nextData };
}

function setIn(root: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  assertSafeKey(head!, "'with' override target");
  // Array-aware: writing into an array index (e.g. "data.items.0.x") must copy the
  // array and recurse into the slot, not clobber the array into a plain object.
  if (Array.isArray(root)) {
    const idx = arrayIndex(head!, root.length);
    if (idx !== undefined) {
      const copy = [...(root as unknown[])];
      copy[idx] = setIn(copy[idx] ?? {}, rest, value);
      return copy;
    }
  }
  const base: { [k: string]: unknown } =
    root !== null && typeof root === "object" && !Array.isArray(root)
      ? { ...(root as { [k: string]: unknown }) }
      : {};
  base[head!] = setIn(hasOwn.call(base, head!) ? base[head!] : {}, rest, value);
  return base;
}

// A canonical, in-range array index for a path segment, or undefined if the segment
// isn't one (so the caller falls back to plain-object behavior).
function arrayIndex(seg: string, length: number): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(seg)) return undefined;
  const n = Number(seg);
  return n <= length ? n : undefined;
}

// Value-correct deep equality. Underpins set dedup and complete/object conflict
// detection, so it must distinguish things === / shallow checks miss (NaN, Dates,
// RegExps, Maps/Sets, typed arrays) without ever calling an object "equal" to an
// array/Map/Set/Date/RegExp of the same keys.
function eq(a: unknown, b: unknown): boolean {
  // Primitives (incl. functions) and identical references: Object.is so that
  // NaN === NaN and +0 !== -0.
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // Non-objects that weren't Object.is-equal (e.g. distinct functions, +0/-0,
    // mismatched primitives) are not equal.
    return false;
  }

  // Cross-kind objects are never equal: a plain object is not an array/Map/Set/etc.
  if (a.constructor !== b.constructor) return false;

  if (a instanceof Date) {
    return a.getTime() === (b as Date).getTime();
  }
  if (a instanceof RegExp) {
    const rb = b as RegExp;
    return a.source === rb.source && a.flags === rb.flags;
  }

  if (a instanceof Map) {
    const mb = b as Map<unknown, unknown>;
    if (a.size !== mb.size) return false;
    for (const [k, v] of a) {
      if (!mb.has(k) || !eq(v, mb.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set) {
    const sb = b as Set<unknown>;
    if (a.size !== sb.size) return false;
    // Membership is by deep equality, so fall back to an O(n^2) scan.
    const remaining = [...sb];
    for (const av of a) {
      const i = remaining.findIndex((bv) => eq(av, bv));
      if (i === -1) return false;
      remaining.splice(i, 1);
    }
    return true;
  }

  if (Array.isArray(a)) {
    const ba = b as unknown[];
    if (a.length !== ba.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!eq(a[i], ba[i])) return false;
    }
    return true;
  }

  // Typed arrays / DataView and other ArrayBuffer views: same constructor (already
  // checked) plus same length and element-wise equality.
  if (ArrayBuffer.isView(a)) {
    if (a instanceof DataView) {
      const db = b as DataView;
      if (a.byteLength !== db.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) {
        if (a.getUint8(i) !== db.getUint8(i)) return false;
      }
      return true;
    }
    const ta = a as unknown as ArrayLike<unknown>;
    const tb = b as unknown as ArrayLike<unknown>;
    if (ta.length !== tb.length) return false;
    for (let i = 0; i < ta.length; i++) {
      if (!Object.is(ta[i], tb[i])) return false;
    }
    return true;
  }

  // Plain objects: same own enumerable keys and deep-equal values.
  // LIMITATION: compares own-enumerable STRING keys only (Object.keys). Symbol
  // keys are ignored, so two objects differing only by a symbol key compare equal.
  // Fine for JSON-ish policy values; documented in the README "Semantics" section.
  const ao = a as { [k: string]: unknown };
  const bo = b as { [k: string]: unknown };
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!eq(ao[k], bo[k])) return false;
  }
  return true;
}
