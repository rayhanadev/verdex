import type { Module } from "./module.ts";
import type { Registry } from "./types.ts";

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

// Extract and intersect every module's registry from a tuple.
type ExtractRegistries<
  Mods extends ReadonlyArray<Module<any, any, any, any>>,
> = {
  [K in keyof Mods]: Mods[K] extends Module<any, any, any, infer R>
    ? R
    : never;
}[number];

export type RegistryOf<
  Mods extends ReadonlyArray<Module<any, any, any, any>>,
> = UnionToIntersection<ExtractRegistries<Mods>> extends infer X extends Registry
  ? X
  : Registry;

export class Bundle<R extends Registry = {}> {
  readonly modules: ReadonlyArray<Module<any, any, any, any>>;
  readonly data: { [k: string]: unknown };

  constructor(init: {
    modules: ReadonlyArray<Module<any, any, any, any>>;
    data?: { [k: string]: unknown };
  }) {
    this.modules = init.modules;
    this.data = init.data ?? {};
  }
}

// Factory: capture module tuple types so the resulting Bundle's R is the union.
export function bundle<
  const Mods extends ReadonlyArray<Module<any, any, any, any>>,
>(init: {
  modules: Mods;
  data?: { [k: string]: unknown };
}): Bundle<RegistryOf<Mods>> {
  return new Bundle(init) as Bundle<RegistryOf<Mods>>;
}
