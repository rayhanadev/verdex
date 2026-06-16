import { describe, expect, test } from "vitest";
import { Engine, module } from "../src/index.ts";

// D2: ctx.store is a read-only ReadonlyStore facade (get(path) + version). A rule
// can still read through the live document but can neither mutate shared engine
// state nor reach the live root via .document. The full mutable Store lives on the
// engine (engine.put / engine.store).

describe("ctx.store read-only facade", () => {
  test("ctx.store.get still reads through the live document", () => {
    const m = module("p").complete("v", (ctx) => ctx.store.get("count"));
    const e = new Engine().add(m).put("count", 5);
    const d = e.query("p.v");
    expect(d.defined).toBe(true);
    if (d.defined) expect(d.result).toBe(5);
  });

  test("ctx.store.get does pollution-safe own-property lookup", () => {
    (Object.prototype as Record<string, unknown>)["role"] = "admin";
    try {
      const m = module("p").complete("v", (ctx) => ctx.store.get("role"));
      const e = new Engine().add(m);
      const d = e.query("p.v");
      // The inherited "role" must not surface through the facade.
      expect(d.defined).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>)["role"];
    }
  });

  test("ctx.store.version is a number readable from a rule", () => {
    const m = module("p").complete("v", (ctx) => ctx.store.version);
    const e = new Engine().add(m).put("count", 1);
    const d = e.query("p.v");
    if (d.defined) expect(typeof d.result).toBe("number");
  });

  test("calling a mutator through ctx.store is a type error", () => {
    const m = module("p").complete("v", (ctx) => {
      // @ts-expect-error ReadonlyStore has no put() — mutation is statically blocked.
      ctx.store.put("touched", true);
      return true;
    });
    const e = new Engine().add(m);
    // At runtime put is absent, so the call throws TypeError ("not a function").
    expect(() => e.query("p.v")).toThrow(TypeError);
    // The live Store was never written.
    expect(e.store.get("touched")).toBeUndefined();
  });

  test("ctx.store mutators are absent at runtime (put/delete/merge)", () => {
    const m = module("p").complete("v", (ctx) => {
      const s = ctx.store as unknown as Record<string, unknown>;
      return [typeof s.put, typeof s.delete, typeof s.merge];
    });
    const e = new Engine().add(m);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toEqual(["undefined", "undefined", "undefined"]);
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

  test("a guarded mutation through ctx.store is a no-op and does not corrupt the engine", () => {
    const m = module("p").complete("v", (ctx) => {
      const s = ctx.store as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
      s.put?.("hacked", true);
      s.delete?.("count");
      s.merge?.({ hacked: true });
      return true;
    });
    const e = new Engine().add(m).put("count", 7);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toBe(true);
    // None of the in-rule mutations took effect on the live Store.
    expect(e.store.get("hacked")).toBeUndefined();
    expect(e.store.get("count")).toBe(7);
    // The engine remains writable through the supported path.
    e.put("count", 8);
    expect(e.store.get("count")).toBe(8);
  });
});
