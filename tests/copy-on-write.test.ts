import { describe, expect, test } from "vitest";
import { Engine, UnknownRuleError, bundle, module } from "../src/index.ts";

// 0.3 makes modules and engines immutable. In 0.2 every builder call and
// `engine.add()` mutated and returned the same object, so "forking" a module or
// an engine silently shared clauses and packages (a strict variant could allow,
// and a server engine built from a shared one leaked its packages back into it).

describe("modules are copy-on-write", () => {
  test("each builder call returns a new module and leaves the receiver unchanged", () => {
    const base = module("docs").default("edit", false);
    const strict = base.when("edit", () => false);
    const lax = base.when("edit", () => true);
    expect(strict).not.toBe(lax);
    expect(strict).not.toBe(base);
    expect(base.getRules("edit")).toBeUndefined();
    expect(strict.getRules("edit")).toHaveLength(1);
    expect(new Engine().add(strict).docs.edit()).toEqual({ defined: true, result: false });
    expect(new Engine().add(lax).docs.edit()).toEqual({ defined: true, result: true });
    expect(new Engine().add(base).docs.edit()).toEqual({ defined: true, result: false });
  });

  test("forks of a chain do not see each other's later clauses", () => {
    const base = module("p").contains("why", () => true, "base");
    const a = base.contains("why", () => true, "a");
    const b = base.contains("why", () => true, "b");
    expect(new Engine().add(a).p.why()).toEqual({ defined: true, result: ["base", "a"] });
    expect(new Engine().add(b).p.why()).toEqual({ defined: true, result: ["base", "b"] });
  });

  test("modules are frozen", () => {
    const m = module("p").default("x", 1);
    expect(Object.isFrozen(m)).toBe(true);
    expect(m.allRuleNames()).toEqual(["x"]);
  });

  test("a rejected builder call leaves the receiver usable", () => {
    const m = module("p").complete("v", () => 1);
    expect(() =>
      m.set("v", function* () {
        yield 1;
      }),
    ).toThrow();
    expect(new Engine().add(m).p.v()).toEqual({ defined: true, result: 1 });
  });
});

describe("engines are copy-on-write", () => {
  test("add() returns a new engine; the original keeps only its own packages", () => {
    const shared = new Engine().add(module("ui").default("show", true));
    const server = shared.add(module("secret").default("threshold", 250_000));
    expect(server).not.toBe(shared);
    expect(server.secret.threshold()).toEqual({ defined: true, result: 250_000 });
    const untyped = shared as unknown as { query(path: string): unknown };
    expect(() => untyped.query("secret.threshold")).toThrow(UnknownRuleError);
    expect(shared.rules().map((r) => r.path)).toEqual(["ui.show"]);
  });

  test("the same base engine can be extended in several directions", () => {
    const base = new Engine().add(module("a").default("x", 1));
    const left = base.add(module("l").default("y", 2));
    const right = base.add(module("r").default("z", 3));
    expect(left.rules().map((r) => r.path)).toEqual(["a.x", "l.y"]);
    expect(right.rules().map((r) => r.path)).toEqual(["a.x", "r.z"]);
  });

  test("a derived engine gets its own copy of the store", () => {
    const reader = module("r").complete("v", (ctx) => (ctx.data as { v?: number }).v);
    const base = new Engine().put("v", 1);
    const derived = base.add(reader);
    base.put("v", 2);
    expect(derived.r.v()).toEqual({ defined: true, result: 1 });
    derived.put("v", 3);
    expect(base.store.get("v")).toBe(2);
    expect(derived.store.get("v")).toBe(3);
  });

  test("bundle seed data lands only in the engine add() returns", () => {
    const base = new Engine();
    const next = base.add(
      bundle({ modules: [module("p").default("x", 1)], data: { seeded: true } }),
    );
    expect(next.store.get("seeded")).toBe(true);
    expect(base.store.get("seeded")).toBeUndefined();
  });

  test("put() still writes the engine's own store and returns the same engine", () => {
    const e = new Engine().add(module("r").complete("v", (ctx) => (ctx.data as { v: number }).v));
    expect(e.put("v", 1)).toBe(e);
    expect(e.r.v()).toEqual({ defined: true, result: 1 });
  });
});

describe("the store is persistent", () => {
  test("written values are deep-frozen copies; later caller changes do not leak in", () => {
    const value = { list: [1, 2], nested: { x: 1 } };
    const e = new Engine().put("doc", value);
    value.list.push(3);
    value.nested.x = 99;
    expect(e.store.get("doc")).toEqual({ list: [1, 2], nested: { x: 1 } });
    expect(Object.isFrozen(e.store.get("doc"))).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
  });

  test("each write produces a new frozen root; earlier roots are unchanged", () => {
    const e = new Engine().put("a.b", 1);
    const before = e.store.document;
    e.put("a.c", 2);
    expect(before).toEqual({ a: { b: 1 } });
    expect(e.store.document).toEqual({ a: { b: 1, c: 2 } });
    expect(Object.isFrozen(e.store.document)).toBe(true);
    e.store.delete("a.b");
    expect(e.store.document).toEqual({ a: { c: 2 } });
    expect(e.store.delete("a.zzz")).toBe(false);
    expect(e.store.delete("a.c.deeper")).toBe(false);
  });

  test("a non-plain root document is flattened to a plain object", () => {
    class Doc {
      x = 1;
    }
    const e = new Engine().put("", new Doc());
    expect(Object.getPrototypeOf(e.store.document)).toBe(Object.prototype);
    expect(e.store.get("x")).toBe(1);
  });
});
