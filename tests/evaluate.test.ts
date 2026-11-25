import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ConflictError,
  CycleError,
  Engine,
  EvaluationError,
  OverrideError,
  PolicyError,
  RuleQueryError,
  UnknownRuleError,
  ValidationError,
  module,
} from "../src/index.ts";

// A host "panic" type that an app wants to keep propagating unchanged.
class Panic extends Error {
  override name = "Panic";
}

const authz = module("authz", { input: z.object({ role: z.enum(["admin", "guest"]) }) })
  .default("allow", false)
  .when("allow", (ctx) => ctx.input.role === "admin", true, { id: "admin" });

describe("evaluate() never throws for engine failures", () => {
  test("a decision comes back as { ok: true, decision }", () => {
    const e = new Engine().add(authz);
    expect(e.evaluate("authz.allow", { input: { role: "admin" } })).toEqual({
      ok: true,
      decision: { defined: true, result: true },
    });
    expect(e.authz.allow.evaluate({ input: { role: "guest" } })).toEqual({
      ok: true,
      decision: { defined: true, result: false },
    });
  });

  test("validation, conflict, unknown path, func query and bad override are errors", () => {
    const e = new Engine().add(authz).add(
      module("p")
        .complete("conflict", (): number | undefined => 1)
        .complete("conflict", (): number | undefined => 2)
        .func("f", () => 1)
        .complete("ok", () => true),
    );
    const cases: [() => unknown, new (...a: never[]) => PolicyError][] = [
      [() => e.evaluate("authz.allow", { input: { role: "root" as "admin" } }), ValidationError],
      [() => e.evaluate("p.conflict"), ConflictError],
      [() => (e.evaluate as (p: string) => unknown)("p.missing"), UnknownRuleError],
      [() => (e.evaluate as (p: string) => unknown)("p.f"), RuleQueryError],
      [() => e.evaluate("p.ok", { with: [{ target: "nope.x", value: 1 }] }), OverrideError],
    ];
    for (const [run, ErrorClass] of cases) {
      const r = run() as { ok: boolean; error?: unknown };
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(ErrorClass);
    }
  });

  test("an exception from a rule body becomes an EvaluationError that names the clause", () => {
    const boom = new TypeError("cannot read role");
    const m = module("p")
      .when("v", () => false, true, { id: "first" })
      .when(
        "v",
        () => {
          throw boom;
        },
        true,
        { id: "second" },
      );
    const r = new Engine().add(m).evaluate("p.v");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = r.error as EvaluationError;
    expect(err).toBeInstanceOf(EvaluationError);
    expect(err).toBeInstanceOf(PolicyError);
    expect(err.cause).toBe(boom);
    expect(err.path).toBe("p.v");
    expect(err.rulePath).toBe("p.v");
    expect(err.clause).toEqual({ index: 1, id: "second" });
    expect(err.message).toBe('rule "p.v" clause "second" threw: TypeError: cannot read role');
  });

  test("a throw inside a function or a referenced rule is attributed to it", () => {
    const m = module("p")
      .func("explode", (): boolean => {
        throw new Error("func failed");
      })
      .complete("inner", () => {
        throw "inner failed";
      })
      .complete("viaFunc", (ctx) => ctx.p.explode())
      .complete("viaRef", (ctx) => ctx.p.inner());
    const e = new Engine().add(m);
    const viaFunc = e.evaluate("p.viaFunc");
    if (viaFunc.ok) throw new Error("expected failure");
    expect((viaFunc.error as EvaluationError).rulePath).toBe("p.explode");
    expect((viaFunc.error as EvaluationError).clause).toBeUndefined();
    const viaRef = e.evaluate("p.viaRef");
    if (viaRef.ok) throw new Error("expected failure");
    expect((viaRef.error as EvaluationError).rulePath).toBe("p.inner");
    expect((viaRef.error as EvaluationError).clause).toEqual({ index: 0 });
    expect(viaRef.error.message).toBe('rule "p.inner" clause #0 threw: inner failed');
  });

  test("a rule that catches an inner failure and then throws its own error is attributed to itself", () => {
    const m = module("p")
      .complete("inner", (): boolean => {
        throw new Error("inner");
      })
      .complete("outer", (ctx) => {
        try {
          ctx.p.inner();
        } catch {
          // recovered
        }
        throw new Error("outer");
      });
    const r = new Engine().add(m).evaluate("p.outer");
    if (r.ok) throw new Error("expected failure");
    expect((r.error as EvaluationError).rulePath).toBe("p.outer");
  });

  test("a non-policy throw outside any rule (an unsafe with target) is wrapped without a rule", () => {
    const e = new Engine().add(module("p").complete("v", () => 1));
    const r = e.evaluate("p.v", { with: [{ target: "data.__proto__.x", value: 1 }] });
    if (r.ok) throw new Error("expected failure");
    const err = r.error as EvaluationError;
    expect(err).toBeInstanceOf(EvaluationError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(err.rulePath).toBeUndefined();
    expect(err.message).toMatch(/^query "p.v" threw: TypeError/);
  });

  test("a non-Error thrown value is described in the message", () => {
    const e = new Engine().add(
      module("p").complete("v", () => {
        throw { code: 42 };
      }),
    );
    const r = e.evaluate("p.v");
    if (r.ok) throw new Error("expected failure");
    expect(r.error.message).toBe('rule "p.v" clause #0 threw: [object Object]');
  });

  test("cycles are reported as CycleError", () => {
    const m = module("p")
      .default("a", false)
      .complete("a", (ctx) => ctx.p.a());
    const r = new Engine().add(m).evaluate("p.a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(CycleError);
  });

  test("the throwing API is unchanged: query() still throws the raw rule exception", () => {
    const boom = new Error("raw");
    const e = new Engine().add(
      module("p").complete("v", () => {
        throw boom;
      }),
    );
    expect(() => e.query("p.v")).toThrow(boom);
  });
});

describe("rethrow", () => {
  const panicky = module("p").complete("v", (): boolean => {
    throw new Panic("invariant");
  });

  test("an engine-level predicate lets matching values propagate unchanged", () => {
    const e = new Engine({ rethrow: (cause) => cause instanceof Panic }).add(panicky);
    expect(() => e.evaluate("p.v")).toThrow(Panic);
    // Non-matching failures are still values.
    const r = e.evaluate("p.v", { rethrow: () => false });
    expect(r.ok).toBe(false);
  });

  test("a per-call predicate overrides the engine's", () => {
    const e = new Engine().add(panicky);
    expect(e.evaluate("p.v").ok).toBe(false);
    let caught: unknown;
    try {
      e.p.v.evaluate({ rethrow: (cause) => cause instanceof Panic });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Panic);
  });

  test("the predicate sees policy errors too", () => {
    const seen: unknown[] = [];
    const e = new Engine({ rethrow: (c) => (seen.push(c), false) }).add(authz);
    e.evaluate("authz.allow", { input: { role: "x" as "admin" } });
    expect(seen[0]).toBeInstanceOf(ValidationError);
  });
});

describe("evaluate through the proxy", () => {
  test("engine.<pkg>.<rule>.evaluate(opts)", () => {
    const e = new Engine().add(authz);
    const r = e.authz.allow.evaluate({ input: { role: "x" as "admin" } });
    expect(r.ok).toBe(false);
  });

  test("an unknown proxy path reports UnknownRuleError for the rule, not for '.evaluate'", () => {
    const e = new Engine().add(authz) as unknown as Record<string, any>;
    const r = e.nope.rule.evaluate();
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(UnknownRuleError);
    expect((r.error as UnknownRuleError).path).toBe("nope.rule");
    expect(() => e.nope.rule.decide()).toThrow(UnknownRuleError);
    expect(() => e.nope.rule.explain()).toThrow(UnknownRuleError);
    expect(() => e.nope.rule()).toThrow(UnknownRuleError);
  });

  test("a function rule's proxy forms report RuleQueryError", () => {
    const e = new Engine().add(module("p").func("f", () => 1)) as unknown as Record<string, any>;
    expect(() => e.p.f()).toThrow(RuleQueryError);
    expect(e.p.f.evaluate().error).toBeInstanceOf(RuleQueryError);
    expect(() => e.p.f.decide()).toThrow(RuleQueryError);
  });
});

describe("decide()", () => {
  test("returns the result of a defaulted, set or object rule", () => {
    const m = module("p")
      .default("on", false)
      .when("on", (ctx) => (ctx.input as { on?: boolean } | undefined)?.on === true)
      .contains("tags", () => true, "a")
      .object("map", function* () {
        yield ["k", 1];
      });
    const e = new Engine().add(m);
    expect(e.decide("p.on")).toBe(false);
    expect(e.decide("p.on", { input: { on: true } })).toBe(true);
    expect(e.p.on.decide({ input: { on: true } })).toBe(true);
    expect(e.decide("p.tags")).toEqual(["a"]);
    expect(e.decide("p.map")).toEqual({ k: 1 });
  });

  test("throws RuleQueryError when an untyped path produces no value", () => {
    const e = new Engine().add(module("p").complete("v", () => undefined));
    expect(() => (e.decide as (p: string) => unknown)("p.v")).toThrow(RuleQueryError);
  });

  test("an untyped engine accepts string paths", () => {
    const e = new Engine() as Engine;
    expect(() => e.decide("x.y")).toThrow(UnknownRuleError);
    expect(e.evaluate("x.y").ok).toBe(false);
  });
});
