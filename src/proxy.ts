// Type-level: turn a flat `{ "a.b.c": V }` registry into nested `{ a: { b: { c: V } } }`.

type Split<S extends string, V> = S extends `${infer H}.${infer Rest}`
  ? { [K in H]: Split<Rest, V> }
  : { [K in S]: V };

type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

export type Tree<R extends Record<string, unknown>> = UnionToIntersection<
  { [K in keyof R & string]: Split<K, R[K]> }[keyof R & string]
>;

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
      if (typeof prop === "symbol") return undefined;
      if (prop === "toString") {
        return () => `[Proxy ${prefix.join(".")}]`;
      }
      return makePackageProxy([...prefix, prop], invoke);
    },
  });
}
