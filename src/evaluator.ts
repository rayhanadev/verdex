import {
  CompleteRule,
  FuncRule,
  ObjectRule,
  SetRule,
  type Rule,
} from "./rule.ts";
import type { Module } from "./module.ts";
import type { Store } from "./store.ts";
import {
  ConflictError,
  PolicyError,
  UnknownRuleError,
  validate,
} from "./errors.ts";
import { makePackageProxy } from "./proxy.ts";
import type { Context, Decision, Override, QueryOptions } from "./types.ts";
import { splitPath } from "./types.ts";

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
        throw new PolicyError(
          `cannot query function rule "${path}" directly; call it via ctx.call`,
        );
    }
  }

  call(path: string, args: unknown[], opts: QueryOptions = {}): unknown {
    const r = this.resolve(path);
    const rule = r.rules[0];
    if (!(rule instanceof FuncRule)) {
      throw new PolicyError(`"${path}" is not a function rule`);
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
    const base: Context = {
      input,
      data,
      store: this.store,
      call<T = unknown>(path: string, ...args: unknown[]): T {
        return evaluator.call(path, args, opts) as T;
      },
    };
    // Wrap in a Proxy so unknown property accesses become typed-callable
    // package paths: ctx.authz.isAdmin(user) → evaluator.call("authz.isAdmin", [user], opts).
    return new Proxy(base, {
      get(target, prop) {
        if (typeof prop === "symbol") return Reflect.get(target, prop);
        if (prop in target) return Reflect.get(target, prop);
        return makePackageProxy([prop as string], (path, args) =>
          evaluator.call(path, args, opts),
        );
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
      throw new PolicyError(
        `invalid 'with' target "${o.target}": must start with "input" or "data"`,
      );
    }
  }
  return { input: nextInput, data: nextData };
}

function setIn(root: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const base: { [k: string]: unknown } =
    root !== null && typeof root === "object" && !Array.isArray(root)
      ? { ...(root as { [k: string]: unknown }) }
      : {};
  const [head, ...rest] = path;
  base[head!] = setIn(base[head!] ?? {}, rest, value);
  return base;
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!eq(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || Array.isArray(b)) return false;
    const ao = a as { [k: string]: unknown };
    const bo = b as { [k: string]: unknown };
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in bo)) return false;
      if (!eq(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}
