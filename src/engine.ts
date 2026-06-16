import { Bundle } from "./bundle.ts";
import { Evaluator } from "./evaluator.ts";
import { Module, RESERVED } from "./module.ts";
import { makePackageProxy, type Tree } from "./proxy.ts";
import { Store } from "./store.ts";
import type {
  Decision,
  Path,
  QueryOptions,
  Registry,
  RuleEntries,
  RuleKeys,
} from "./types.ts";

class EngineImpl<R extends Registry = {}> {
  private readonly modules: Module<any, any, any, any>[] = [];
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
        return makePackageProxy([prop as string], (path, args) =>
          target.query(
            path as never,
            (args[0] as QueryOptions | undefined) ?? {},
          ),
        );
      },
    }) as Engine<R>;
  }

  add<R2 extends Registry>(m: Module<any, any, any, R2>): Engine<R & R2>;
  add<R2 extends Registry>(b: Bundle<R2>): Engine<R & R2>;
  add(x: Module<any, any, any, any> | Bundle<any>): Engine<Registry> {
    if (x instanceof Bundle) {
      for (const m of x.modules) this.modules.push(m);
      if (Object.keys(x.data).length > 0) this.store.merge(x.data);
    } else {
      this.modules.push(x);
    }
    return this as unknown as Engine<Registry>;
  }

  put(path: Path, value: unknown): this {
    this.store.put(path, value);
    return this;
  }

  // Typed overload — path must exist in the registry, return is Decision<R[P]>.
  // Function paths are excluded; call them via ctx.call from inside a rule.
  query<P extends RuleKeys<R>>(path: P, opts?: QueryOptions): Decision<R[P]>;
  // String fallback only when no rule paths are known (untyped engines).
  query<T = unknown>(
    path: [RuleKeys<R>] extends [never] ? string : never,
    opts?: QueryOptions,
  ): Decision<T>;
  query(path: string, opts?: QueryOptions): Decision<unknown> {
    return new Evaluator(this.modules, this.store).query(path, opts);
  }
}

// `Engine<R>` — class methods + nested-package proxy tree (typed view of rule paths).
// `engine.authz.allow({ input })` becomes a typed callable for any rule path in R.
export type Engine<R extends Registry = {}> = EngineImpl<R> & Tree<RuleEntries<R>>;

export const Engine = EngineImpl as unknown as new <
  R extends Registry = {},
>() => Engine<R>;
