import type { Context, Registry } from "./types.ts";
import type { StandardSchemaV1 } from "./schema.ts";

export type RuleKind = "complete" | "set" | "object" | "func";

export abstract class Rule {
  abstract readonly kind: RuleKind;
  constructor(public readonly name: string) {}
}

export type CompleteFn<I, D, R extends Registry, X> = (
  ctx: Context<I, D, R>,
) => X | undefined;

export class CompleteRule<
  I = unknown,
  D = unknown,
  R extends Registry = {},
  X = unknown,
> extends Rule {
  readonly kind = "complete" as const;
  constructor(name: string, public readonly fn: CompleteFn<I, D, R, X>) {
    super(name);
  }
}

export type SetFn<I, D, R extends Registry, X> = (
  ctx: Context<I, D, R>,
) => Iterable<X>;

export class SetRule<
  I = unknown,
  D = unknown,
  R extends Registry = {},
  X = unknown,
> extends Rule {
  readonly kind = "set" as const;
  constructor(name: string, public readonly fn: SetFn<I, D, R, X>) {
    super(name);
  }
}

export type ObjectFn<I, D, R extends Registry, V> = (
  ctx: Context<I, D, R>,
) => Iterable<readonly [string, V]>;

export class ObjectRule<
  I = unknown,
  D = unknown,
  R extends Registry = {},
  V = unknown,
> extends Rule {
  readonly kind = "object" as const;
  constructor(name: string, public readonly fn: ObjectFn<I, D, R, V>) {
    super(name);
  }
}

export interface FuncSchemas {
  args?: ReadonlyArray<StandardSchemaV1>;
  output?: StandardSchemaV1;
}

export type FuncFn<
  I,
  D,
  R extends Registry,
  Args extends readonly unknown[],
  Out,
> = (ctx: Context<I, D, R>, ...args: Args) => Out;

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
