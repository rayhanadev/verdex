type Resolver<TIn, TOut> = TOut | ((x: TIn) => TOut);

interface Branch<TIn, TOut> {
  pred: (x: TIn) => boolean;
  value: Resolver<TIn, TOut>;
}

export interface Matcher<TIn, TOut> {
  when<U>(
    pred: (x: TIn) => boolean,
    value: Resolver<TIn, U>,
  ): Matcher<TIn, TOut | U>;
  otherwise(fallback: Resolver<TIn, TOut>): TOut;
}

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
