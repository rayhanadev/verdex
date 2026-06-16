import { CompleteRule, FuncRule, ObjectRule, SetRule, type Rule } from "./rule.ts";
import type { Module } from "./module.ts";
import type { Store } from "./store.ts";
import {
  ConflictError,
  OverrideError,
  RuleQueryError,
  UnknownRuleError,
  validate,
} from "./errors.ts";
import { isReservedMetaProp, makePackageProxy } from "./proxy.ts";
import type { Context, Decision, Override, QueryOptions } from "./types.ts";
import { assertSafeKey, splitPath } from "./types.ts";

interface Resolved {
  module: Module<any, any, any, any>;
  rules: readonly Rule[];
  ruleName: string;
}

export class Evaluator {
  constructor(
    private readonly modules: ReadonlyArray<Module<any, any, any, any>>,
    private readonly store: Store,
  ) {}

  query<T = unknown>(path: string, opts: QueryOptions = {}): Decision<T> {
    const r = this.resolve(path);
    const ctx = this.makeContext(r.module, opts);
    if (r.rules.length === 0) {
      return this.evalComplete(r, ctx) as Decision<T>;
    }
    const first = r.rules[0]!;
    switch (first.kind) {
      case "complete":
        return this.evalComplete(r, ctx) as Decision<T>;
      case "set":
        return this.evalSet(r, ctx) as Decision<T>;
      case "object":
        return this.evalObject(r, ctx) as Decision<T>;
      case "func":
        throw new RuleQueryError(
          `cannot query function rule "${path}" directly; call it via ctx.call`,
        );
    }
  }

  call(path: string, args: unknown[], opts: QueryOptions = {}): unknown {
    const r = this.resolve(path);
    const rule = r.rules[0];
    if (!(rule instanceof FuncRule)) {
      throw new RuleQueryError(`"${path}" is not a function rule`);
    }
    const ctx = this.makeContext(r.module, opts);
    let validatedArgs: unknown[] = args;
    if (rule.schemas?.args) {
      validatedArgs = rule.schemas.args.map((schema, i) =>
        validate(schema, args[i], `${path} arg[${i}]`),
      );
    }
    const out = rule.fn(ctx, ...(validatedArgs as never[]));
    if (rule.schemas?.output) {
      return validate(rule.schemas.output, out, `${path} output`);
    }
    return out;
  }

  private resolve(path: string): Resolved {
    const segments = splitPath(path);
    if (segments.length === 0) throw new UnknownRuleError(path);
    for (let split = segments.length - 1; split >= 0; split--) {
      const pkgName = segments.slice(0, split).join(".");
      const ruleName = segments.slice(split).join(".");
      if (ruleName.includes(".")) continue;
      for (const m of this.modules) {
        if (m.package.name === pkgName) {
          const rules = m.getRules(ruleName);
          if (rules && rules.length > 0) {
            return { module: m, rules, ruleName };
          }
          if (m.hasDefault(ruleName)) {
            return { module: m, rules: [], ruleName };
          }
        }
      }
    }
    throw new UnknownRuleError(path);
  }

  private makeContext(module: Module<any, any, any, any>, opts: QueryOptions): Context {
    const baseInput =
      module.inputSchema !== undefined
        ? validate(module.inputSchema, opts.input, `${module.package.name} input`)
        : opts.input;
    let baseData = this.store.document;
    if (module.dataSchema !== undefined) {
      baseData = validate(module.dataSchema, baseData, `${module.package.name} data`);
    }
    const { input, data } = applyOverrides(baseInput, baseData, opts.with ?? []);
    const evaluator = this;
    // Snapshot + deep-freeze the per-query input/data so a rule body cannot mutate
    // the shared data document (the live Store) or the caller's input. We clone the
    // data first because, with no overrides, it is the live Store's root object —
    // freezing it directly would seize up future put/merge/delete. ctx.store is a
    // frozen read-only facade (get/version) built fresh per query, so a rule can
    // still read through the live document but cannot mutate shared engine state.
    const base: Context = {
      input: deepFreeze(deepClone(input)),
      data: deepFreeze(deepClone(data)),
      store: this.store.asReadonly(),
      call<T = unknown>(path: string, ...args: unknown[]): T {
        return evaluator.call(path, args, opts) as T;
      },
    };
    // Wrap in a Proxy so unknown property accesses become typed-callable
    // package paths: ctx.authz.isAdmin(user) → evaluator.call("authz.isAdmin", [user], opts).
    return new Proxy(base, {
      get(target, prop) {
        // Own-property only: the real ctx members (input/data/store/call) are own
        // keys. Inherited Object.prototype members (constructor/hasOwnProperty/
        // valueOf/…) must fall through to the package-path logic below rather than
        // silently shadow a same-named package — `module()` already rejects the
        // names that would actually resolve to a member (see RESERVED).
        if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(target, prop)) {
          return Reflect.get(target, prop);
        }
        if (typeof prop === "symbol") return Reflect.get(target, prop);
        // Reserved meta-props (then/catch/finally/toJSON/toString) on a
        // non-existent property must not become a package path — otherwise
        // `await ctx` sees a callable `.then` and JSON.stringify/inspection recurses.
        if (isReservedMetaProp(prop)) return undefined;
        return makePackageProxy([prop as string], (path, args) => evaluator.call(path, args, opts));
      },
    });
  }

  private evalComplete(r: Resolved, ctx: Context): Decision {
    const fullPath = `${r.module.package.name}.${r.ruleName}`;
    const values: unknown[] = [];
    for (const rule of r.rules) {
      if (!(rule instanceof CompleteRule)) continue;
      const v = rule.fn(ctx);
      if (v !== undefined) values.push(v);
    }
    if (values.length === 0) {
      if (r.module.hasDefault(r.ruleName)) {
        return { defined: true, result: r.module.getDefault(r.ruleName) };
      }
      return { defined: false };
    }
    const first = values[0];
    for (let i = 1; i < values.length; i++) {
      if (!eq(first, values[i])) {
        throw new ConflictError(fullPath, values);
      }
    }
    return { defined: true, result: first };
  }

  private evalSet(r: Resolved, ctx: Context): Decision<unknown[]> {
    const out: unknown[] = [];
    for (const rule of r.rules) {
      if (!(rule instanceof SetRule)) continue;
      for (const item of rule.fn(ctx)) {
        if (!out.some((x) => eq(x, item))) out.push(item);
      }
    }
    return { defined: true, result: out };
  }

  private evalObject(r: Resolved, ctx: Context): Decision<{ [k: string]: unknown }> {
    const fullPath = `${r.module.package.name}.${r.ruleName}`;
    const out: { [k: string]: unknown } = {};
    for (const rule of r.rules) {
      if (!(rule instanceof ObjectRule)) continue;
      for (const [k, v] of rule.fn(ctx)) {
        if (k in out) {
          if (!eq(out[k], v)) {
            throw new ConflictError(`${fullPath}[${JSON.stringify(k)}]`, [out[k], v]);
          }
        } else {
          out[k] = v;
        }
      }
    }
    return { defined: true, result: out };
  }
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
  base[head!] = setIn(base[head!] ?? {}, rest, value);
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

// Structural clone of plain JSON-ish trees (objects + arrays). Non-plain values
// (Dates, RegExps, Maps, functions, typed arrays, etc.) are passed through by
// reference — deepFreeze still freezes the ones it can. This exists so the per-query
// data snapshot is detached from the live Store before being frozen.
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) => deepClone(v)) as unknown as T;
  }
  // Only clone plain objects; leave exotic objects (Date/RegExp/Map/etc.) intact.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: { [k: string]: unknown } = {};
  for (const k of Object.keys(value as { [k: string]: unknown })) {
    out[k] = deepClone((value as { [k: string]: unknown })[k]);
  }
  return out as unknown as T;
}

// Recursively Object.freeze a snapshot so rule bodies can't mutate it. Skips
// already-frozen subtrees (also guards against shared/cyclic refs once frozen) and
// only recurses into arrays and plain objects.
// LIMITATION: exotic containers are NOT deeply frozen. Object.freeze on a Map/Set
// doesn't lock its entries, and we don't recurse into Date/RegExp/typed arrays/
// class instances — so such a value placed in ctx.data stays internally mutable.
// Keep policy data JSON-shaped for the freeze guarantee to hold; see README "Semantics".
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const v of value as unknown[]) deepFreeze(v);
  } else {
    for (const k of Object.keys(value as { [k: string]: unknown })) {
      deepFreeze((value as { [k: string]: unknown })[k]);
    }
  }
  return value;
}
