import { describe, expect, test } from "vitest";
import { z } from "zod";
import { Engine, PolicyError, module } from "../src/index.ts";

const Input = z.object({ roles: z.array(z.string()), viewerId: z.string(), ownerId: z.string() });
const owner = { roles: ["member"], viewerId: "u1", ownerId: "u1" };
const stranger = { roles: ["member"], viewerId: "u2", ownerId: "u1" };

const authz = module("authz", { input: Input, version: 3 })
  .func("isOwner", (ctx) => ctx.input.viewerId === ctx.input.ownerId)
  .default("allow", false)
  .when("allow", (ctx) => ctx.input.roles.includes("super_admin"), true, { id: "super_admin_role" })
  .when("allow", (ctx) => ctx.authz.isOwner(), true, { id: "owner" })
  .contains("why", (ctx) => !ctx.authz.isOwner(), "not_owner", { id: "ownership" })
  .contains("why", (ctx) => !ctx.input.roles.includes("super_admin"), "not_admin");

describe("explain()", () => {
  test("reports the decision, each clause by id, and the func calls", () => {
    const e = new Engine().add(authz);
    const x = e.explain("authz.allow", { input: owner });
    expect(x.decision).toEqual({ defined: true, result: true });
    expect(x.path).toBe("authz.allow");
    expect(x.kind).toBe("complete");
    expect(x.defaulted).toBe(false);
    expect(x.clauses).toEqual([
      { index: 0, id: "super_admin_role", matched: false },
      { index: 1, id: "owner", matched: true, value: true },
    ]);
    expect(x.calls).toEqual([
      { kind: "func", path: "authz.isOwner", args: [], result: true, cached: false },
    ]);
    expect(x.policy.fingerprint).toBe(e.fingerprint());
    expect(x.policy.modules).toEqual([
      { package: "authz", version: 3, fingerprint: e.rules()[0]!.module.fingerprint },
    ]);
    expect(typeof x.durationMs).toBe("number");
    expect(x.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("marks a decision that fell back to the default", () => {
    const x = new Engine().add(authz).authz.allow.explain({ input: stranger });
    expect(x.decision).toEqual({ defined: true, result: false });
    expect(x.defaulted).toBe(true);
    expect(x.clauses.every((c) => !c.matched)).toBe(true);
  });

  test("set clauses report the members they yielded", () => {
    const x = new Engine().add(authz).explain("authz.why", { input: stranger });
    expect(x.decision).toEqual({ defined: true, result: ["not_owner", "not_admin"] });
    expect(x.kind).toBe("set");
    expect(x.defaulted).toBe(false);
    expect(x.clauses).toEqual([
      { index: 0, id: "ownership", matched: true, value: ["not_owner"] },
      { index: 1, matched: true, value: ["not_admin"] },
    ]);
  });

  test("object clauses report their entries", () => {
    const m = module("idx")
      .object(
        "byId",
        function* () {
          yield ["a", 1];
        },
        { id: "first" },
      )
      .object("byId", function* () {});
    const x = new Engine().add(m).explain("idx.byId");
    expect(x.clauses).toEqual([
      { index: 0, id: "first", matched: true, value: [["a", 1]] },
      { index: 1, matched: false },
    ]);
  });

  test("rule references appear as calls with their own clauses, and memo hits as cached", () => {
    const m = module("money")
      .contains("elevated", (ctx) => (ctx.input as { amount: number }).amount > 100, "amount", {
        id: "big",
      })
      .complete("tier", (ctx) =>
        ctx.money.elevated().length > 0 && ctx.money.elevated().length < 9
          ? "elevated"
          : "standard",
      );
    const x = new Engine().add(m).explain("money.tier", { input: { amount: 500 } });
    expect(x.decision).toEqual({ defined: true, result: "elevated" });
    expect(x.calls).toEqual([
      {
        kind: "rule",
        path: "money.elevated",
        args: [],
        result: { defined: true, result: ["amount"] },
        cached: false,
        clauses: [{ index: 0, id: "big", matched: true, value: ["amount"] }],
      },
      {
        kind: "rule",
        path: "money.elevated",
        args: [],
        result: { defined: true, result: ["amount"] },
        cached: true,
      },
    ]);
  });

  test("lists every module the query touched", () => {
    const helper = module("helpers", { version: "2026-11" }).func(
      "double",
      (_c, n: number) => n * 2,
    );
    const main = module("main").complete("v", (ctx) =>
      ctx.call("helpers.double" as never, 2 as never),
    );
    const x = new Engine().add(helper).add(main).explain("main.v");
    expect(x.policy.modules.map((m) => [m.package, m.version])).toEqual([
      ["main", undefined],
      ["helpers", "2026-11"],
    ]);
    expect("version" in x.policy.modules[0]!).toBe(false);
  });

  test("explain throws like query", () => {
    const e = new Engine().add(authz);
    expect(() => e.explain("authz.allow", { input: { roles: 1 } as never })).toThrow(PolicyError);
  });
});

describe("evaluate({ trace: true })", () => {
  test("returns the trace with a successful evaluation", () => {
    const r = new Engine().add(authz).evaluate("authz.allow", { input: owner, trace: true });
    expect(r.ok).toBe(true);
    expect(r.trace?.clauses.map((c) => c.id)).toEqual(["super_admin_role", "owner"]);
  });

  test("returns the partial trace with a failure", () => {
    const m = module("p")
      .when("v", () => false, true, { id: "a" })
      .when(
        "v",
        () => {
          throw new Error("x");
        },
        true,
        { id: "b" },
      );
    const r = new Engine().add(m).evaluate("p.v", { trace: true });
    expect(r.ok).toBe(false);
    expect(r.trace?.clauses).toEqual([{ index: 0, id: "a", matched: false }]);
    expect(r.trace?.defaulted).toBe(false);
  });

  test("an unknown path fails without a trace", () => {
    const r = (new Engine() as Engine).evaluate("x.y", { trace: true });
    expect(r.ok).toBe(false);
    expect(r.trace).toBeUndefined();
  });

  test("the normal path records nothing", () => {
    const r = new Engine().add(authz).evaluate("authz.allow", { input: owner });
    expect(r).toEqual({ ok: true, decision: { defined: true, result: true } });
    expect("trace" in r).toBe(false);
  });
});

describe("clause ids", () => {
  test("must be unique within a rule", () => {
    const m = module("p").when("v", () => true, true, { id: "x" });
    expect(() => m.when("v", () => false, true, { id: "x" })).toThrow(PolicyError);
    expect(() => m.when("w", () => false, true, { id: "x" })).not.toThrow();
  });
});

describe("policy fingerprints", () => {
  const build = (threshold: number, version?: number) =>
    module("limits", version === undefined ? {} : { version })
      .default("max", threshold)
      .when("over", (ctx) => (ctx.input as { n: number }).n > 10);

  test("are stable for the same policy and independent of add order and data", () => {
    const a = module("a").default("x", { b: 1, a: [1, 2] });
    const b = module("b").set("s", function* () {
      yield 1;
    });
    const e1 = new Engine().add(a).add(b);
    const e2 = new Engine().add(b).add(a);
    expect(e1.fingerprint()).toBe(e2.fingerprint());
    expect(e1.fingerprint()).toMatch(/^[0-9a-f]{28}$/);
    expect(e1.put("data", 1).fingerprint()).toBe(e2.fingerprint());
    expect(e1.withData({ other: true }).fingerprint()).toBe(e2.fingerprint());
    const same = module("a").default("x", { a: [1, 2], b: 1 });
    expect(new Engine().add(same).add(b).fingerprint()).toBe(e1.fingerprint());
  });

  test("change when defaults, clause bodies, ids, values or versions change", () => {
    const base = new Engine().add(build(5)).fingerprint();
    expect(new Engine().add(build(6)).fingerprint()).not.toBe(base);
    expect(new Engine().add(build(5, 2)).fingerprint()).not.toBe(base);
    const otherBody = module("limits")
      .default("max", 5)
      .when("over", (ctx) => (ctx.input as { n: number }).n > 11);
    expect(new Engine().add(otherBody).fingerprint()).not.toBe(base);
    const withId = module("limits")
      .default("max", 5)
      .when("over", (ctx) => (ctx.input as { n: number }).n > 10, true, { id: "n" });
    expect(new Engine().add(withId).fingerprint()).not.toBe(base);
    const otherValue = module("limits")
      .default("max", 5)
      .when("over", (ctx) => (ctx.input as { n: number }).n > 10, "yes");
    expect(new Engine().add(otherValue).fingerprint()).not.toBe(base);
  });

  test("ignore documentation metadata", () => {
    const plain = module("p").default("x", 1);
    const documented = module("p", { description: "docs" }).default("x", 1, { description: "x" });
    expect(new Engine().add(plain).fingerprint()).toBe(new Engine().add(documented).fingerprint());
  });

  test("hash exotic default values deterministically", () => {
    const sym = Symbol("s");
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const exotic = () =>
      module("p")
        .default("d", new Date(0))
        .default("r", /x/g)
        .default("m", new Map([["k", new Set([1n, -0, undefined, null, true])]]))
        .default("f", function named() {})
        .default("s", sym)
        .default("c", cyclic)
        .func("schemaed", { args: [z.string()], output: z.boolean() }, () => true);
    expect(new Engine().add(exotic()).fingerprint()).toBe(new Engine().add(exotic()).fingerprint());
  });
});
