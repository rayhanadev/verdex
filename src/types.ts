import type { Store } from "./store.ts";
import type { Tree } from "./proxy.ts";

export type Registry = Record<string, unknown>;

export interface Override {
  target: string;
  value: unknown;
}

export interface QueryOptions {
  input?: unknown;
  with?: readonly Override[];
}

// Pull arg/return types out of a registry entry that's a function signature.
export type ArgsOf<F> = F extends (...args: infer A) => any ? A : never;
export type RetOf<F> = F extends (...args: any) => infer R ? R : never;

// Keys in R whose value is a callable signature — these are the func paths.
export type FuncKeys<R extends Registry> = {
  [K in keyof R]: R[K] extends (...a: any) => any ? K : never;
}[keyof R] &
  string;

// Keys whose value is NOT callable — queryable rule paths.
export type RuleKeys<R extends Registry> = {
  [K in keyof R]: R[K] extends (...a: any) => any ? never : K;
}[keyof R] &
  string;

// Shape registry entries before tree-building so leaves are correctly typed.
export type FuncEntries<R extends Registry> = { [K in FuncKeys<R>]: R[K] };
export type RuleEntries<R extends Registry> = {
  [K in RuleKeys<R>]: (opts?: QueryOptions) => Decision<R[K]>;
};

export interface ContextBase<
  I = unknown,
  D = unknown,
  R extends Registry = {},
> {
  readonly input: I;
  readonly data: D;
  readonly store: Store;
  call<P extends FuncKeys<R>>(path: P, ...args: ArgsOf<R[P]>): RetOf<R[P]>;
  // String fallback only kicks in when no func paths are known.
  call(
    path: [FuncKeys<R>] extends [never] ? string : never,
    ...args: unknown[]
  ): unknown;
}

// `Context` = base members + nested-package proxy tree (typed view of FuncRules).
export type Context<
  I = unknown,
  D = unknown,
  R extends Registry = {},
> = ContextBase<I, D, R> & Tree<FuncEntries<R>>;

export type Decision<T = unknown> =
  | { readonly defined: true; readonly result: T }
  | { readonly defined: false; readonly result?: undefined };

export type Path = string | readonly string[];

export function splitPath(path: Path): string[] {
  if (typeof path === "string") {
    return path.length === 0 ? [] : path.split(".");
  }
  return [...path];
}
