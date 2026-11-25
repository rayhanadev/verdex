// Type-level helpers for the nested proxy views (`engine.a.b.c`, `ctx.a.b.c`) over a
// set of dotted paths. The views are mapped types keyed by the next path segment,
// so a property lookup only computes the segment names at that level, and a
// subtree is only built when it is accessed. (0.2 built the whole tree eagerly
// with a UnionToIntersection over every path, which made every `.add()` lookup
// pay for the full tree.)

/** The next segment of each dotted path in `K` (`"a.b.c"` → `"a"`; `"x"` → `"x"`). */
export type Segment<K extends string> = K extends `${infer H}.${string}` ? H : K;

/** The rest of each path in `K` below the segment `C` (`"a.b.c"` below `"a"` → `"b.c"`). */
export type Below<K extends string, C extends string> = K extends `${C}.${infer T}` ? T : never;

/** Append the segment `C` to the path prefix `P`. */
export type Join<P extends string, C extends string> = P extends "" ? C : `${P}.${C}`;

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
