import {
  CompleteRule,
  FuncRule,
  ObjectRule,
  Rule,
  SetRule,
  type CompleteFn,
  type FuncFn,
  type FuncSchemas,
  type ObjectFn,
  type SetFn,
} from "./rule.ts";
import { RuleKindMismatchError } from "./errors.ts";
import type { StandardSchemaV1 } from "./schema.ts";
import type { Context, Registry } from "./types.ts";

export class Package {
  readonly segments: readonly string[];
  constructor(public readonly name: string) {
    this.segments = name.length === 0 ? [] : name.split(".");
  }
  toString(): string {
    return this.name;
  }
}

type ArgsOut<T extends ReadonlyArray<StandardSchemaV1>> = {
  [K in keyof T]: StandardSchemaV1.InferOutput<T[K]>;
};

// Add a new path → T, unioning with any existing entry at that path.
// (Multiple complete/set/object clauses for the same name combine, so types union.)
type Add<R extends Registry, P extends string, N extends string, T> = Omit<
  R,
  `${P}.${N}`
> & {
  [K in `${P}.${N}`]: `${P}.${N}` extends keyof R ? R[`${P}.${N}`] | T : T;
};

export class Module<
  P extends string = string,
  I = unknown,
  D = unknown,
  R extends Registry = {},
> {
  readonly package: Package;
  readonly inputSchema: StandardSchemaV1<unknown, I> | undefined;
  readonly dataSchema: StandardSchemaV1<unknown, D> | undefined;

  private readonly rules: Map<string, Rule[]> = new Map();
  private readonly defaults: Map<string, unknown> = new Map();

  constructor(
    packageName: P,
    schemas?: {
      input?: StandardSchemaV1<unknown, I>;
      data?: StandardSchemaV1<unknown, D>;
    },
  ) {
    this.package = new Package(packageName);
    this.inputSchema = schemas?.input;
    this.dataSchema = schemas?.data;
  }

  default<N extends string, V>(
    name: N,
    value: V,
  ): Module<P, I, D, Add<R, P, N, V>> {
    this.defaults.set(name, value);
    return this as unknown as Module<P, I, D, Add<R, P, N, V>>;
  }

  complete<N extends string, X>(
    name: N,
    fn: CompleteFn<I, D, R, X>,
  ): Module<P, I, D, Add<R, P, N, X>> {
    this.put(name, new CompleteRule(name, fn));
    return this as unknown as Module<P, I, D, Add<R, P, N, X>>;
  }

  set<N extends string, X>(
    name: N,
    fn: SetFn<I, D, R, X>,
  ): Module<P, I, D, Add<R, P, N, X[]>> {
    this.put(name, new SetRule(name, fn));
    return this as unknown as Module<P, I, D, Add<R, P, N, X[]>>;
  }

  object<N extends string, V>(
    name: N,
    fn: ObjectFn<I, D, R, V>,
  ): Module<P, I, D, Add<R, P, N, { [k: string]: V }>> {
    this.put(name, new ObjectRule(name, fn));
    return this as unknown as Module<P, I, D, Add<R, P, N, { [k: string]: V }>>;
  }

  // Function with Standard Schemas — args & output typed from them.
  func<
    N extends string,
    const Args extends ReadonlyArray<StandardSchemaV1>,
    Out extends StandardSchemaV1,
  >(
    name: N,
    schemas: { args: Args; output: Out },
    fn: FuncFn<I, D, R, ArgsOut<Args>, StandardSchemaV1.InferOutput<Out>>,
  ): Module<
    P,
    I,
    D,
    Add<R, P, N, (...args: ArgsOut<Args>) => StandardSchemaV1.InferOutput<Out>>
  >;
  // Function without schemas — args/output are whatever the fn declares.
  func<N extends string, Args extends readonly unknown[], Out>(
    name: N,
    fn: FuncFn<I, D, R, Args, Out>,
  ): Module<P, I, D, Add<R, P, N, (...args: Args) => Out>>;
  func(
    name: string,
    a:
      | FuncFn<I, D, R, readonly unknown[], unknown>
      | { args: ReadonlyArray<StandardSchemaV1>; output: StandardSchemaV1 },
    b?: FuncFn<I, D, R, readonly unknown[], unknown>,
  ): Module<P, I, D, any> {
    if (typeof a === "function") {
      this.put(
        name,
        new FuncRule(name, a as FuncFn<I, D, R, unknown[], unknown>),
      );
    } else {
      this.put(
        name,
        new FuncRule(
          name,
          b! as FuncFn<I, D, R, unknown[], unknown>,
          a satisfies FuncSchemas,
        ),
      );
    }
    return this as unknown as Module<P, I, D, any>;
  }

  // Sugar: register a complete-rule clause that returns `value` (default true) when pred is true.
  when<N extends string>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
  ): Module<P, I, D, Add<R, P, N, true>>;
  when<N extends string, V>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
    value: V,
  ): Module<P, I, D, Add<R, P, N, V>>;
  when(
    name: string,
    pred: (ctx: Context<I, D, R>) => boolean,
    value?: unknown,
  ): Module<P, I, D, any> {
    const v = arguments.length >= 3 ? value : true;
    this.put(
      name,
      new CompleteRule<I, D, R, unknown>(name, (ctx) =>
        pred(ctx) ? (v as unknown) : undefined,
      ),
    );
    return this as unknown as Module<P, I, D, any>;
  }

  // Sugar: yield `value` into a partial set when pred is true.
  contains<N extends string, V>(
    name: N,
    pred: (ctx: Context<I, D, R>) => boolean,
    value: V,
  ): Module<P, I, D, Add<R, P, N, V[]>> {
    this.put(
      name,
      new SetRule<I, D, R, V>(name, function* (ctx) {
        if (pred(ctx)) yield value;
      }),
    );
    return this as unknown as Module<P, I, D, Add<R, P, N, V[]>>;
  }

  getRules(name: string): readonly Rule[] | undefined {
    return this.rules.get(name);
  }

  getDefault(name: string): unknown {
    return this.defaults.get(name);
  }

  hasDefault(name: string): boolean {
    return this.defaults.has(name);
  }

  ruleNames(): readonly string[] {
    return [...this.rules.keys()];
  }

  private put(name: string, rule: Rule): void {
    const existing = this.rules.get(name);
    if (!existing) {
      this.rules.set(name, [rule]);
      return;
    }
    const firstKind = existing[0]!.kind;
    if (firstKind !== rule.kind) {
      throw new RuleKindMismatchError(name, firstKind, rule.kind);
    }
    if (rule.kind === "func") {
      throw new RuleKindMismatchError(name, "func", "func (duplicate)");
    }
    existing.push(rule);
  }
}

// Reserved root segments — collide with built-in members of `ctx` / `engine`.
export const RESERVED: ReadonlySet<string> = new Set([
  "input",
  "data",
  "store",
  "call",
  "add",
  "put",
  "query",
]);

// Factory function that captures the package name as a literal type.
export function module<
  const P extends string,
  I = unknown,
  D = unknown,
>(
  packageName: P,
  schemas?: {
    input?: StandardSchemaV1<unknown, I>;
    data?: StandardSchemaV1<unknown, D>;
  },
): Module<P, I, D, {}> {
  const root = packageName.split(".")[0]!;
  if (RESERVED.has(root)) {
    throw new Error(
      `package root "${root}" is reserved (collides with ctx/engine members: ${[...RESERVED].join(", ")})`,
    );
  }
  return new Module(packageName, schemas);
}
