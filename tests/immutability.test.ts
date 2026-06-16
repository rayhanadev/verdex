import { describe, expect, test } from "vitest";
import { Engine, module } from "../src/index.ts";

// makeContext snapshots + deep-freezes the per-query input/data so a rule body
// cannot mutate the caller's input or the shared (live Store) data document.
// Test files are ES modules => strict mode, so writes to frozen objects throw.

describe("ctx.input / ctx.data are frozen", () => {
  test("mutating a top-level ctx.data property throws", () => {
    const m = module("p").complete("v", (ctx) => {
      (ctx.data as { count: number }).count = 999;
      return true;
    });
    const e = new Engine().add(m).put("count", 1);
    expect(() => e.query("p.v")).toThrow(TypeError);
  });

  test("mutating a nested ctx.data property throws", () => {
    const m = module("p").complete("v", (ctx) => {
      (ctx.data as { nested: { x: number } }).nested.x = 42;
      return true;
    });
    const e = new Engine().add(m).put("nested", { x: 1 });
    expect(() => e.query("p.v")).toThrow(TypeError);
  });

  test("pushing onto a nested array in ctx.data throws", () => {
    const m = module("p").complete("v", (ctx) => {
      (ctx.data as { items: number[] }).items.push(4);
      return true;
    });
    const e = new Engine().add(m).put("items", [1, 2, 3]);
    expect(() => e.query("p.v")).toThrow(TypeError);
  });

  test("mutating ctx.input throws", () => {
    const m = module("p").complete("v", (ctx) => {
      (ctx.input as { user: string }).user = "mallory";
      return true;
    });
    const e = new Engine().add(m);
    expect(() => e.query("p.v", { input: { user: "alice" } })).toThrow(TypeError);
  });

  test("ctx.data and ctx.input are reported frozen by Object.isFrozen", () => {
    let dataFrozen = false;
    let inputFrozen = false;
    let nestedFrozen = false;
    const m = module("p").complete("v", (ctx) => {
      dataFrozen = Object.isFrozen(ctx.data);
      inputFrozen = Object.isFrozen(ctx.input);
      nestedFrozen = Object.isFrozen((ctx.data as { nested: unknown }).nested);
      return true;
    });
    const e = new Engine().add(m).put("nested", { x: 1 });
    e.query("p.v", { input: { a: 1 } });
    expect(dataFrozen).toBe(true);
    expect(inputFrozen).toBe(true);
    expect(nestedFrozen).toBe(true);
  });
});

describe("shared data document survives queries", () => {
  test("the store is unchanged across multiple queries despite frozen snapshots", () => {
    // A rule that merely reads data; the Store must keep working query after query.
    const m = module("p").complete("v", (ctx) => (ctx.data as { count: number }).count);
    const e = new Engine().add(m).put("count", 7);

    const a = e.query("p.v");
    const b = e.query("p.v");
    if (a.defined) expect(a.result).toBe(7);
    if (b.defined) expect(b.result).toBe(7);

    // The live Store can still be written after queries froze their snapshots.
    e.put("count", 8);
    const c = e.query("p.v");
    if (c.defined) expect(c.result).toBe(8);
  });

  test("a failed in-rule mutation does not corrupt the live Store", () => {
    const m = module("p").complete("v", (ctx) => {
      (ctx.data as { count: number }).count = 999; // throws (frozen)
      return true;
    });
    const e = new Engine().add(m).put("count", 1);
    expect(() => e.query("p.v")).toThrow(TypeError);
    // Store value is untouched; read it through a non-mutating module.
    const reader = module("r").complete("v", (ctx) => (ctx.data as { count: number }).count);
    const e2 = new Engine().add(reader).put("count", 1);
    const d = e2.query("r.v");
    if (d.defined) expect(d.result).toBe(1);
    expect(e.store.get("count")).toBe(1);
  });

  test("ctx.store is a read-only facade: in-rule mutation is absent and does not mutate", () => {
    // ctx.store is now a frozen ReadonlyStore facade: put/delete/merge are absent,
    // so a (guarded) call is a no-op and the live Store is never written from a rule.
    const m = module("p").complete("v", (ctx) => {
      const s = ctx.store as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
      // The mutators do not exist on the facade.
      expect(s.put).toBeUndefined();
      expect(s.delete).toBeUndefined();
      expect(s.merge).toBeUndefined();
      // Guarded call is a no-op (optional chaining short-circuits the absent fn).
      s.put?.("touched", true);
      return true;
    });
    const e = new Engine().add(m);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toBe(true);
    // The in-rule write never happened — the live Store is untouched.
    expect(e.store.get("touched")).toBeUndefined();
  });

  test("ctx.store.get still reads through the live document", () => {
    const m = module("p").complete("v", (ctx) => ctx.store.get("count"));
    const e = new Engine().add(m).put("count", 5);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toBe(5);
  });

  test("ctx.store.version is readable from a rule", () => {
    const m = module("p").complete("v", (ctx) => ctx.store.version);
    const e = new Engine().add(m).put("count", 1);
    const d = e.query("p.v");
    if (d.defined) expect(typeof d.result).toBe("number");
  });

  test("ctx.store.document is not exposed (live-root leak closed)", () => {
    const m = module("p").complete("v", (ctx) => (ctx.store as { document?: unknown }).document);
    const e = new Engine().add(m).put("count", 1);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toBeUndefined();
  });

  test("ctx.store facade is frozen", () => {
    const m = module("p").complete("v", (ctx) => Object.isFrozen(ctx.store));
    const e = new Engine().add(m);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toBe(true);
  });

  test("ctx.store mutators are absent (put/delete/merge)", () => {
    const m = module("p").complete("v", (ctx) => {
      const s = ctx.store as unknown as Record<string, unknown>;
      return [typeof s.put, typeof s.delete, typeof s.merge];
    });
    const e = new Engine().add(m);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toEqual(["undefined", "undefined", "undefined"]);
  });
});
