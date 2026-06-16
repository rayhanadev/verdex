// Type-level: turn a flat `{ "a.b.c": V }` registry into nested `{ a: { b: { c: V } } }`.

type Split<S extends string, V> = S extends `${infer H}.${infer Rest}`
  ? { [K in H]: Split<Rest, V> }
  : { [K in S]: V };

type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (x: infer I) => void
  ? I
  : never;

export type Tree<R extends Record<string, unknown>> = UnionToIntersection<
  { [K in keyof R & string]: Split<K, R[K]> }[keyof R & string]
>;

// Properties that must NOT be turned into a dispatchable package path.
// These are JS-runtime hooks that ordinary operations (await, JSON.stringify,
// console.log/inspect) probe for; recursing into a callable proxy for them makes
// the engine look like a broken thenable / blows up serialization.
const RESERVED_META_PROPS: ReadonlySet<string> = new Set([
  // thenable trio — `await x` reads `x.then`
  "then",
  "catch",
  "finally",
  // serialization / inspection hooks
  "toJSON",
  "toString",
]);

export function isReservedMetaProp(prop: string | symbol): boolean {
  // Any symbol (Symbol.iterator, Symbol.asyncIterator, Symbol.toPrimitive,
  // Symbol.toStringTag, Symbol.for("nodejs.util.inspect.custom"), ...) is a
  // runtime hook, never a package path.
  if (typeof prop === "symbol") return true;
  return RESERVED_META_PROPS.has(prop);
}

// Runtime: a callable proxy that walks property accesses into a path
// and dispatches the eventual call through `invoke`.

export function makePackageProxy(
  prefix: readonly string[],
  invoke: (path: string, args: unknown[]) => unknown,
): any {
  const target: any = function () {};
  return new Proxy(target, {
    apply(_t, _thisArg, args: unknown[]) {
      return invoke(prefix.join("."), args);
    },
    get(_t, prop) {
      // `toString` keeps its proxy-label behavior; every other reserved
      // meta-prop (and any symbol) returns undefined instead of recursing.
      if (prop === "toString") {
        return () => `[Proxy ${prefix.join(".")}]`;
      }
      if (isReservedMetaProp(prop)) return undefined;
      return makePackageProxy([...prefix, prop as string], invoke);
    },
  });
}
