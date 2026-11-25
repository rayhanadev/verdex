import { describe, expect, test } from "vitest";
import { z } from "zod";
import { CycleError, Engine, RuleQueryError, UnknownRuleError, module } from "../src/index.ts";

const Money = z.object({ amount: z.number(), method: z.enum(["ach", "wire"]) });

describe("rule references inside rules", () => {
  test("ctx.<pkg>.<rule>() reads another rule's value", () => {
    const money = module("money", { input: Money })
      .contains("elevated", (ctx) => ctx.input.amount >= 250_000, "amount")
      .contains("elevated", (ctx) => ctx.input.method === "wire", "wire")
      .complete("tier", (ctx) => (ctx.money.elevated().length > 0 ? "elevated" : "standard"));
    const e = new Engine().add(money);
    expect(e.money.tier({ input: { amount: 10, method: "ach" } })).toEqual({
      defined: true,
      result: "standard",
    });
    expect(e.money.tier({ input: { amount: 300_000, method: "ach" } })).toEqual({
      defined: true,
      result: "elevated",
    });
  });

  test("an undefined rule reads as undefined; ctx.query returns the full Decision", () => {
    const m = module("p")
      .complete("maybe", (ctx) => ((ctx.input as { on: boolean }).on ? 1 : undefined))
      .complete("viaProxy", (ctx) => ({ value: ctx.p.maybe() }))
      .complete("viaQuery", (ctx) => ctx.query("p.maybe"));
    const e = new Engine().add(m);
    expect(e.p.viaProxy({ input: { on: false } })).toEqual({
      defined: true,
      result: { value: undefined },
    });
    expect(e.p.viaQuery({ input: { on: false } })).toEqual({
      defined: true,
      result: { defined: false },
    });
    expect(e.p.viaQuery({ input: { on: true } })).toEqual({
      defined: true,
      result: { defined: true, result: 1 },
    });
  });

  test("a referenced rule is evaluated once per query (memoized)", () => {
    let runs = 0;
    const m = module("p")
      .complete("expensive", () => {
        runs++;
        return 42;
      })
      .complete("a", (ctx) => ctx.p.expensive())
      .complete("b", (ctx) => ctx.p.expensive()! + ctx.p.expensive()!)
      .complete("both", (ctx) => [ctx.p.a(), ctx.p.b(), ctx.query("p.expensive")]);
    const e = new Engine().add(m);
    expect(e.p.both()).toEqual({
      defined: true,
      result: [42, 84, { defined: true, result: 42 }],
    });
    expect(runs).toBe(1);
    e.p.both();
    expect(runs).toBe(2); // memoized per query, not across queries
  });

  test("references reach rules in other modules with that module's input schema", () => {
    const limits = module("limits", { input: z.object({ count: z.coerce.number() }) })
      .default("over", false)
      .when("over", (ctx) => ctx.input.count > 10);
    const gate = module("gate").complete("verdict", (ctx) =>
      ctx.query("limits.over" as never).result ? "deny" : "allow",
    );
    const e = new Engine().add(limits).add(gate);
    expect(e.gate.verdict({ input: { count: "11" } })).toEqual({ defined: true, result: "deny" });
    expect(e.gate.verdict({ input: { count: "3" } })).toEqual({ defined: true, result: "allow" });
  });

  test("a self-reference throws CycleError naming the loop", () => {
    const m = module("p")
      .default("loop", false)
      .complete("loop", (ctx) => ctx.p.loop());
    const e = new Engine().add(m);
    let caught: unknown;
    try {
      e.p.loop();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CycleError);
    expect((caught as CycleError).cycle).toEqual(["p.loop", "p.loop"]);
    expect((caught as CycleError).message).toBe("rule reference cycle: p.loop -> p.loop");
  });

  test("an indirect cycle through string references is detected", () => {
    const m = module("p")
      .complete("a", (ctx) => (ctx.query as (p: string) => unknown)("p.b"))
      .complete("b", (ctx) => (ctx.query as (p: string) => unknown)("p.c"))
      .complete("c", (ctx) => (ctx.query as (p: string) => unknown)("p.a"));
    expect(() => new Engine().add(m).p.a()).toThrow(CycleError);
    try {
      new Engine().add(m).p.b();
    } catch (err) {
      expect((err as CycleError).cycle).toEqual(["p.b", "p.c", "p.a", "p.b"]);
    }
  });

  test("a rule may recover from a failing reference and reference again", () => {
    let attempts = 0;
    const m = module("p")
      .complete("flaky", (): number => {
        attempts++;
        throw new Error("nope");
      })
      .complete("safe", (ctx) => {
        for (let i = 0; i < 2; i++) {
          try {
            ctx.p.flaky();
          } catch {
            // ignored: the stack must be unwound, so no false CycleError
          }
        }
        return "recovered";
      });
    expect(new Engine().add(m).p.safe()).toEqual({ defined: true, result: "recovered" });
    expect(attempts).toBe(2); // failures are not memoized
  });

  test("rule references take no arguments; func paths are not queryable through ctx.query", () => {
    const m = module("p")
      .default("on", true)
      .func("f", () => 1)
      .complete("withArgs", (ctx) => (ctx.p.on as unknown as (a: number) => unknown)(1))
      .complete("queryFunc", (ctx) => (ctx.query as (p: string) => unknown)("p.f"))
      .complete("unknown", (ctx) => (ctx.query as (p: string) => unknown)("p.nope"));
    const e = new Engine().add(m);
    expect(() => e.p.withArgs()).toThrow(RuleQueryError);
    expect(() => e.p.queryFunc()).toThrow(RuleQueryError);
    expect(() => e.p.unknown()).toThrow(UnknownRuleError);
  });

  test("ctx.call still refuses non-function rules (unchanged)", () => {
    const m = module("p")
      .default("on", true)
      .complete("v", (ctx) => (ctx.call as (p: string) => unknown)("p.on"));
    expect(() => new Engine().add(m).p.v()).toThrow(RuleQueryError);
  });
});

describe("function calls are memoized per query", () => {
  test("a zero-argument function runs once per query", () => {
    let runs = 0;
    const m = module("p")
      .func("isOwner", () => {
        runs++;
        return true;
      })
      .complete("a", (ctx) => ctx.p.isOwner())
      .contains("why", (ctx) => !ctx.p.isOwner(), "not_owner")
      .complete("all", (ctx) => [ctx.p.a(), ctx.p.why(), ctx.p.isOwner(), ctx.call("p.isOwner")]);
    const e = new Engine().add(m);
    expect(e.p.all()).toEqual({ defined: true, result: [true, [], true, true] });
    expect(runs).toBe(1);
  });

  test("calls are keyed by argument identity", () => {
    const seen: unknown[] = [];
    const m = module("p")
      .func("double", (_ctx, n: number) => {
        seen.push(n);
        return n * 2;
      })
      .func("size", (_ctx, o: { items: number[] }) => {
        seen.push(o);
        return o.items.length;
      })
      .complete("v", (ctx) => {
        const list = { items: [1, 2] };
        return [
          ctx.p.double(2),
          ctx.p.double(2),
          ctx.p.double(3),
          ctx.p.size(list),
          ctx.p.size(list), // same object: cached
          ctx.p.size({ items: [1, 2] }), // equal but distinct object: runs again
        ];
      });
    expect(new Engine().add(m).p.v()).toEqual({ defined: true, result: [4, 4, 6, 2, 2, 2] });
    expect(seen).toHaveLength(4);
  });

  test("a throwing function is not memoized", () => {
    let runs = 0;
    const m = module("p")
      .func("boom", (): boolean => {
        runs++;
        throw new Error("x");
      })
      .complete("v", (ctx) => {
        for (let i = 0; i < 2; i++) {
          try {
            ctx.p.boom();
          } catch {
            // ignored
          }
        }
        return runs;
      });
    expect(new Engine().add(m).p.v()).toEqual({ defined: true, result: 2 });
  });

  test("schema-validated functions validate on the first call only", () => {
    const m = module("p")
      .func(
        "isAdmin",
        { args: [z.object({ role: z.string() })], output: z.boolean() },
        (_c, u) => u.role === "admin",
      )
      .complete("v", (ctx) => {
        const user = { role: "admin" };
        return ctx.p.isAdmin(user) && ctx.p.isAdmin(user);
      });
    expect(new Engine().add(m).p.v()).toEqual({ defined: true, result: true });
  });
});
