import type { Module } from "./module.ts";
import type { Registry } from "./types.ts";

// Extract every module's registry from a tuple, as a union.
type ExtractRegistries<Mods extends ReadonlyArray<Module<any, any, any, any, any, any>>> = {
  [K in keyof Mods]: Mods[K] extends Module<any, any, any, infer R, any, any> ? R : never;
}[number];

/**
 * The combined registry of a tuple of modules — the union of every module's
 * registry, so the bundle's type knows about all their rule paths at once. A
 * union stays flat, which keeps type-checking linear in the number of modules.
 */
export type RegistryOf<Mods extends ReadonlyArray<Module<any, any, any, any, any, any>>> =
  ExtractRegistries<Mods>;

/**
 * A reusable group of modules plus seed `data`, addable to an {@link Engine} in a
 * single `add()` call (which returns a new engine). The phantom `R` carries the combined registry so the
 * engine infers every rule path the bundle contributes. Build one with {@link bundle}.
 *
 * @typeParam R - the combined registry of all modules in the bundle
 */
// oxlint-disable-next-line no-unused-vars -- R is a phantom type parameter consumed by Engine.add for registry inference
export class Bundle<R extends Registry = never> {
  /** The modules grouped by this bundle. */
  readonly modules: ReadonlyArray<Module<any, any, any, any, any, any>>;
  /** Seed data merged into the engine's store when the bundle is added. */
  readonly data: { [k: string]: unknown };

  constructor(init: {
    modules: ReadonlyArray<Module<any, any, any, any, any, any>>;
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
export function bundle<
  const Mods extends ReadonlyArray<Module<any, any, any, any, any, any>>,
>(init: { modules: Mods; data?: { [k: string]: unknown } }): Bundle<RegistryOf<Mods>> {
  return new Bundle(init) as Bundle<RegistryOf<Mods>>;
}
