import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  Engine,
  bundle,
  module,
  type Decision,
  type Evaluation,
  type Explanation,
  type PolicyError,
} from "../src/index.ts";

// These assertions are checked by `bun run typecheck` (tsgo over tests/); at
// runtime expectTypeOf is a no-op, so each test also runs the code it types.

const Facts = z.object({
  viewer: z.object({ id: z.string(), roles: z.array(z.enum(["admin", "member"])) }),
  ownerId: z.string(),
  at: z.coerce.date(),
});
const facts = { viewer: { id: "u1", roles: ["member" as const] }, ownerId: "u1", at: "2026-01-01" };

const docs = module("docs", { input: Facts })
  .func("isOwner", (ctx) => ctx.input.viewer.id === ctx.input.ownerId)
  .default("edit", false)
  .when("edit", (ctx) => ctx.docs.isOwner(), true, { id: "owner" })
  .contains("why", (ctx) => !ctx.docs.isOwner(), "not_owner" as const)
  .complete("label", (ctx) => (ctx.docs.edit() ? "editor" : undefined));

const engine = new Engine().add(docs);

describe("typed query input (P1-1)", () => {
  test("query input is the schema's input type; rules see its output type", () => {
    module("t", { input: Facts }).complete("x", (ctx) => {
      expectTypeOf(ctx.input.at).toEqualTypeOf<Date>();
      return ctx.input.at.getTime();
    });
    // `at` accepts anything z.coerce.date() accepts (its input type is unknown).
    expect(engine.docs.edit({ input: facts }).defined).toBe(true);
    expect(engine.query("docs.edit", { input: { ...facts, at: new Date(0) } }).defined).toBe(true);
  });

  test("a wrong input shape is a compile error on every query surface", () => {
    if (false as boolean) {
      // @ts-expect-error viewer must be an object
      engine.docs.edit({ input: { ...facts, viewer: 1 } });
      // @ts-expect-error missing ownerId
      engine.query("docs.edit", { input: { viewer: facts.viewer, at: 1 } });
      // @ts-expect-error roles are an enum
      engine.evaluate("docs.edit", { input: { ...facts, viewer: { id: "u", roles: ["root"] } } });
      // @ts-expect-error input is required when the schema rejects undefined
      engine.docs.edit();
      // @ts-expect-error input is required on decide as well
      engine.decide("docs.edit", {});
    }
    expect(true).toBe(true);
  });

  test("input stays optional for modules without a schema", () => {
    const free = new Engine().add(module("free").default("ok", true));
    expectTypeOf<Parameters<typeof free.free.ok>[0]>().toEqualTypeOf<
      | { input?: unknown; data?: unknown; with?: readonly { target: string; value: unknown }[] }
      | undefined
    >();
    expect(free.free.ok().defined).toBe(true);
  });

  test("per-query data is typed by the module's data schema", () => {
    const m = module("cfg", { data: z.object({ limit: z.number() }) }).complete(
      "limit",
      (ctx) => ctx.data.limit,
    );
    const e = new Engine().add(m);
    if (false as boolean) {
      // @ts-expect-error limit must be a number
      e.cfg.limit({ data: { limit: "10" } });
    }
    expect(e.cfg.limit({ data: { limit: 10 } })).toEqual({ defined: true, result: 10 });
  });
});

describe("result types", () => {
  test("query, evaluate, explain and compile carry the rule's result type", () => {
    expectTypeOf(engine.docs.edit({ input: facts })).toEqualTypeOf<Decision<boolean>>();
    expectTypeOf(engine.query("docs.why", { input: facts })).toEqualTypeOf<
      Decision<"not_owner"[]>
    >();
    expectTypeOf(engine.evaluate("docs.label", { input: facts })).toEqualTypeOf<
      Evaluation<"editor">
    >();
    expectTypeOf(engine.docs.label.explain({ input: facts })).toEqualTypeOf<
      Explanation<"editor">
    >();
    const handle = engine.compile("docs.edit");
    expectTypeOf(handle({ input: facts })).toEqualTypeOf<Decision<boolean>>();
    const failed = engine.evaluate("docs.edit", { input: facts });
    if (!failed.ok) expectTypeOf(failed.error).toEqualTypeOf<PolicyError>();
    expect(handle({ input: facts })).toEqual({ defined: true, result: true });
  });

  test("function rules are not queryable", () => {
    if (false as boolean) {
      // @ts-expect-error func paths are not query paths
      engine.query("docs.isOwner", { input: facts });
      // @ts-expect-error nor compile paths
      engine.compile("docs.isOwner");
    }
    expect(true).toBe(true);
  });
});

describe("decide() for always-defined rules (P1-4)", () => {
  test("returns the result type directly", () => {
    expectTypeOf(engine.decide("docs.edit", { input: facts })).toEqualTypeOf<boolean>();
    expectTypeOf(engine.docs.why.decide({ input: facts })).toEqualTypeOf<"not_owner"[]>();
    expect(engine.decide("docs.edit", { input: facts })).toBe(true);
  });

  test("is a compile error for a rule that can be undefined", () => {
    if (false as boolean) {
      // @ts-expect-error docs.label has no default
      engine.decide("docs.label", { input: facts });
      // @ts-expect-error the handle has no decide member either
      engine.docs.label.decide({ input: facts });
    }
    expect(true).toBe(true);
  });
});

describe("typed rule references (P1-3)", () => {
  test("ctx.<pkg>.<rule>() returns the value; undefined only when the rule can be undefined", () => {
    module("r")
      .default("on", false)
      .complete("maybe", () => (Math.random() > 2 ? ("x" as const) : undefined))
      .set("tags", function* () {
        yield "a" as const;
      })
      .complete("probe", (ctx) => {
        expectTypeOf(ctx.r.on()).toEqualTypeOf<boolean>();
        expectTypeOf(ctx.r.maybe()).toEqualTypeOf<"x" | undefined>();
        expectTypeOf(ctx.r.tags()).toEqualTypeOf<"a"[]>();
        expectTypeOf(ctx.query("r.maybe")).toEqualTypeOf<Decision<"x">>();
        if (false as boolean) {
          // @ts-expect-error rule references take no arguments
          ctx.r.on(1);
          // @ts-expect-error only earlier rules are visible
          ctx.r.probe();
        }
        return true;
      });
    expect(true).toBe(true);
  });
});

describe("registries at scale (P1-2)", () => {
  test("bundle() and chained add() produce the same typed surface", () => {
    const a = module("a").default("x", 1);
    const b = module("b.c").default("y", "s");
    const viaBundle = new Engine().add(bundle({ modules: [a, b] }));
    const viaAdd = new Engine().add(a).add(b);
    expectTypeOf(viaBundle.b.c.y()).toEqualTypeOf<Decision<string>>();
    expectTypeOf(viaAdd.b.c.y()).toEqualTypeOf<Decision<string>>();
    expectTypeOf(viaAdd.decide("a.x")).toEqualTypeOf<number>();
    if (false as boolean) {
      // @ts-expect-error unknown paths are still rejected
      viaAdd.query("a.nope");
    }
    expect(viaBundle.decide("b.c.y")).toBe("s");
  });

  test("rules() paths are the registry's paths", () => {
    expectTypeOf(engine.rules()[0]!.path).toEqualTypeOf<
      "docs.isOwner" | "docs.edit" | "docs.why" | "docs.label"
    >();
    expect(engine.rules().map((r) => r.path)).toEqual([
      "docs.isOwner",
      "docs.edit",
      "docs.why",
      "docs.label",
    ]);
  });
});
