import type { Module } from "./module.ts";
import type { Registry } from "./types.ts";

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;

// Extract and intersect every module's registry from a tuple.
type ExtractRegistries<Mods extends ReadonlyArray<Module<any, any, any, any>>> = {
  [K in keyof Mods]: Mods[K] extends Module<any, any, any, infer R> ? R : never;
}[number];

/**
 * The combined registry of a tuple of modules — the intersection of every
 * module's individual registry, so the bundle's type knows about all their rule
 * paths at once.
 */
export type RegistryOf<Mods extends ReadonlyArray<Module<any, any, any, any>>> =
  UnionToIntersection<ExtractRegistries<Mods>> extends infer X extends Registry ? X : Registry;

/**
 * A reusable group of modules plus seed `data`, addable to an {@link Engine} in a
 * single `add()` call. The phantom `R` carries the combined registry so the
 * engine infers every rule path the bundle contributes. Build one with {@link bundle}.
 *
 * @typeParam R - the combined registry of all modules in the bundle
 */
// oxlint-disable-next-line no-unused-vars -- R is a phantom type parameter consumed by Engine.add for registry inference
export class Bundle<R extends Registry = {}> {
  /** The modules grouped by this bundle. */
  readonly modules: ReadonlyArray<Module<any, any, any, any>>;
  /** Seed data merged into the engine's store when the bundle is added. */
  readonly data: { [k: string]: unknown };

  constructor(init: {
    modules: ReadonlyArray<Module<any, any, any, any>>;
    data?: { [k: string]: unknown };
  }) {
    this.modules = init.modules;
    this.data = init.data ?? {};
  }
}

/**
 * Group modules (and optional seed `data`) into a {@link Bundle}, capturing the
 * module tuple's types so the bundle's registry is the intersection of them all.
 *
 * @param init - the `modules` to bundle and optional `data` to seed the store with
 * @returns a `Bundle` whose registry combines every module's rule paths
 */
export function bundle<const Mods extends ReadonlyArray<Module<any, any, any, any>>>(init: {
  modules: Mods;
  data?: { [k: string]: unknown };
}): Bundle<RegistryOf<Mods>> {
  return new Bundle(init) as Bundle<RegistryOf<Mods>>;
}
