type Resolver<TIn, TOut> = TOut | ((x: TIn) => TOut);

interface Branch<TIn, TOut> {
  pred: (x: TIn) => boolean;
  value: Resolver<TIn, TOut>;
}

/**
 * A fluent, first-match-wins matcher over a fixed input. Each {@link when} adds a
 * branch; {@link otherwise} evaluates them in order and resolves the first whose
 * predicate is true, falling back to the supplied default. The accumulated
 * result type `TOut` widens with every branch.
 *
 * @typeParam TIn - the input value being matched
 * @typeParam TOut - the union of branch result types added so far
 */
export interface Matcher<TIn, TOut> {
  /**
   * Add a branch: if `pred(input)` is true, the match resolves to `value`
   * (or `value(input)` when it is a function).
   *
   * @param pred - predicate tested against the input
   * @param value - the branch's result, or a function computing it from the input
   * @returns the matcher, with `U` unioned into the result type
   */
  when<U>(pred: (x: TIn) => boolean, value: Resolver<TIn, U>): Matcher<TIn, TOut | U>;
  /**
   * Evaluate branches in declaration order and return the first match, or
   * `fallback` (resolved against the input) if none matched.
   *
   * @param fallback - result used when no branch predicate is true
   * @returns the resolved result value
   */
  otherwise(fallback: Resolver<TIn, TOut>): TOut;
}

/**
 * Begin a first-match-wins match over `input`. Chain {@link Matcher.when} branches
 * and finish with {@link Matcher.otherwise}; branches are evaluated lazily in order
 * only when `otherwise` is called.
 *
 * @param input - the value to match against
 * @returns a {@link Matcher} to chain branches onto
 *
 * @example
 * ```ts
 * const tier = match(user.spend)
 *   .when((s) => s > 1000, "gold")
 *   .when((s) => s > 100, "silver")
 *   .otherwise("bronze");
 * ```
 */
export function match<TIn>(input: TIn): Matcher<TIn, never> {
  const branches: Branch<TIn, unknown>[] = [];
  const matcher = {
    when(pred: (x: TIn) => boolean, value: Resolver<TIn, unknown>) {
      branches.push({ pred, value });
      return matcher;
    },
    otherwise(fallback: Resolver<TIn, unknown>): unknown {
      for (const b of branches) {
        if (b.pred(input)) return resolve(b.value, input);
      }
      return resolve(fallback, input);
    },
  };
  return matcher as unknown as Matcher<TIn, never>;
}

function resolve<TIn, TOut>(v: Resolver<TIn, TOut>, x: TIn): TOut {
  return typeof v === "function" ? (v as (x: TIn) => TOut)(x) : v;
}
