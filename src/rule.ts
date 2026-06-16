import type { Context, Registry } from "./types.ts";
import type { StandardSchemaV1 } from "./schema.ts";

/** Discriminator identifying which of the four rule flavours a {@link Rule} is. */
export type RuleKind = "complete" | "set" | "object" | "func";

/**
 * Base class for the compiled rule objects a {@link Module} stores. Construct rules
 * through `Module`'s builder methods, not directly.
 * @internal
 */
export abstract class Rule {
  abstract readonly kind: RuleKind;
  constructor(public readonly name: string) {}
}

/**
 * Body of a `complete` rule: returns a single value, or `undefined` when the
 * clause does not apply.
 */
export type CompleteFn<I, D, R extends Registry, X> = (ctx: Context<I, D, R>) => X | undefined;

/**
 * A complete rule — at most one value per query; multiple matching clauses with
 * differing values raise a `ConflictError`. Built via `Module.complete`.
 * @internal
 */
export class CompleteRule<
  I = unknown,
  D = unknown,
  R extends Registry = {},
  X = unknown,
> extends Rule {
  readonly kind = "complete" as const;
  constructor(
    name: string,
    public readonly fn: CompleteFn<I, D, R, X>,
  ) {
    super(name);
  }
}

/** Body of a `set` rule: yields zero or more members, collected into an array. */
export type SetFn<I, D, R extends Registry, X> = (ctx: Context<I, D, R>) => Iterable<X>;

/**
 * A partial-set rule — clauses contribute members that are unioned together.
 * Built via `Module.set`.
 * @internal
 */
export class SetRule<I = unknown, D = unknown, R extends Registry = {}, X = unknown> extends Rule {
  readonly kind = "set" as const;
  constructor(
    name: string,
    public readonly fn: SetFn<I, D, R, X>,
  ) {
    super(name);
  }
}

/** Body of an `object` rule: yields `[key, value]` entries assembled into an object. */
export type ObjectFn<I, D, R extends Registry, V> = (
  ctx: Context<I, D, R>,
) => Iterable<readonly [string, V]>;

/**
 * A partial-object rule — clauses contribute `[key, value]` entries merged into
 * one object. Built via `Module.object`.
 * @internal
 */
export class ObjectRule<
  I = unknown,
  D = unknown,
  R extends Registry = {},
  V = unknown,
> extends Rule {
  readonly kind = "object" as const;
  constructor(
    name: string,
    public readonly fn: ObjectFn<I, D, R, V>,
  ) {
    super(name);
  }
}

/** Optional Standard Schemas validating a function rule's arguments and output. */
export interface FuncSchemas {
  /** Per-argument schemas, validated positionally against the call arguments. */
  args?: ReadonlyArray<StandardSchemaV1>;
  /** Schema validating the function's return value. */
  output?: StandardSchemaV1;
}

/** Body of a `func` rule: receives `ctx` plus typed arguments and returns a value. */
export type FuncFn<I, D, R extends Registry, Args extends readonly unknown[], Out> = (
  ctx: Context<I, D, R>,
  ...args: Args
) => Out;

/**
 * A callable function rule — invoked from another rule via `ctx.call` rather than
 * queried directly. Built via `Module.func`.
 * @internal
 */
export class FuncRule<
  I = unknown,
  D = unknown,
  R extends Registry = {},
  Args extends readonly unknown[] = unknown[],
  Out = unknown,
> extends Rule {
  readonly kind = "func" as const;
  constructor(
    name: string,
    public readonly fn: FuncFn<I, D, R, Args, Out>,
    public readonly schemas?: FuncSchemas,
  ) {
    super(name);
  }
}
