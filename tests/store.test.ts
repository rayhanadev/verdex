import { describe, expect, test } from "vitest";
import { Store } from "../src/index.ts";

describe("Store.get", () => {
  test("reads a top-level value", () => {
    const s = new Store();
    s.put("a", 1);
    expect(s.get("a")).toBe(1);
  });

  test("reads a nested value via dotted path and via segment array", () => {
    const s = new Store();
    s.put("a.b.c", 42);
    expect(s.get("a.b.c")).toBe(42);
    expect(s.get(["a", "b", "c"])).toBe(42);
  });

  test("missing path returns undefined", () => {
    const s = new Store();
    s.put("a.b", 1);
    expect(s.get("a.x")).toBeUndefined();
    expect(s.get("a.b.c.d")).toBeUndefined();
    expect(s.get("nope")).toBeUndefined();
  });

  test("walking into a non-object (array/primitive) segment returns undefined", () => {
    const s = new Store();
    s.put("arr", [1, 2, 3]);
    s.put("num", 5);
    // The store treats arrays as opaque leaves for path-walking purposes.
    expect(s.get("arr.0")).toBeUndefined();
    expect(s.get("num.x")).toBeUndefined();
  });

  test("the empty path returns the whole document", () => {
    const s = new Store();
    s.put("a", 1);
    expect(s.get("")).toEqual({ a: 1 });
    expect(s.get([])).toEqual({ a: 1 });
  });

  test("does not surface inherited prototype members", () => {
    (Object.prototype as Record<string, unknown>)["injected"] = "x";
    try {
      const s = new Store();
      expect(s.get("injected")).toBeUndefined();
    } finally {
      delete (Object.prototype as Record<string, unknown>)["injected"];
    }
  });
});

describe("Store.put", () => {
  test("creates intermediate objects", () => {
    const s = new Store();
    s.put("x.y.z", "deep");
    expect(s.get("x.y.z")).toBe("deep");
    expect(s.get("x.y")).toEqual({ z: "deep" });
  });

  test("overwrites an existing value", () => {
    const s = new Store();
    s.put("a", 1);
    s.put("a", 2);
    expect(s.get("a")).toBe(2);
  });

  test("can store an array value as a leaf", () => {
    const s = new Store();
    s.put("list", [1, 2, 3]);
    expect(s.get("list")).toEqual([1, 2, 3]);
  });

  test("putting through an existing array slot replaces the array with an object", () => {
    const s = new Store();
    s.put("a", [1, 2]);
    // Intermediate is an array, not a plain object, so it is replaced with a fresh
    // object on the way down (arrays are not walked as intermediate containers).
    s.put("a.b", 3);
    expect(s.get("a.b")).toBe(3);
  });

  test("empty path replaces the root with the given object", () => {
    const s = new Store();
    s.put("a", 1);
    s.put("", { fresh: true });
    expect(s.get("")).toEqual({ fresh: true });
    expect(s.get("a")).toBeUndefined();
  });

  test("empty-path put rejects non-object roots", () => {
    const s = new Store();
    expect(() => s.put("", 5 as unknown as object)).toThrow(TypeError);
    expect(() => s.put("", null as unknown as object)).toThrow(TypeError);
    expect(() => s.put("", [1, 2] as unknown as object)).toThrow(TypeError);
  });

  test("rejects unsafe key segments (prototype pollution guard)", () => {
    const s = new Store();
    expect(() => s.put("__proto__.role", "admin")).toThrow(TypeError);
    expect(() => s.put("a.constructor.x", 1)).toThrow(TypeError);
    expect(() => s.put("a.prototype.x", 1)).toThrow(TypeError);
    expect(({} as Record<string, unknown>).role).toBeUndefined();
  });
});

describe("Store.delete", () => {
  test("removes an existing leaf and returns true", () => {
    const s = new Store();
    s.put("a.b", 1);
    expect(s.delete("a.b")).toBe(true);
    expect(s.get("a.b")).toBeUndefined();
    expect(s.get("a")).toEqual({});
  });

  test("returns false for an absent path", () => {
    const s = new Store();
    s.put("a.b", 1);
    expect(s.delete("a.x")).toBe(false);
    expect(s.delete("nope")).toBe(false);
    expect(s.delete("a.b.c.d")).toBe(false);
  });

  test("returns false when an intermediate segment is not an object", () => {
    const s = new Store();
    s.put("a", [1, 2]);
    expect(s.delete("a.0")).toBe(false);
  });

  test("empty path clears the whole document and returns true", () => {
    const s = new Store();
    s.put("a", 1);
    s.put("b", 2);
    expect(s.delete("")).toBe(true);
    expect(s.get("")).toEqual({});
  });

  test("rejects unsafe key segments", () => {
    const s = new Store();
    expect(() => s.delete("__proto__")).toThrow(TypeError);
    expect(() => s.delete("a.constructor")).toThrow(TypeError);
  });
});

describe("Store.merge", () => {
  test("deep-merges nested plain objects key by key", () => {
    const s = new Store();
    s.put("a", { x: 1, y: 2 });
    s.merge({ a: { y: 20, z: 30 }, b: 99 });
    expect(s.get("a")).toEqual({ x: 1, y: 20, z: 30 });
    expect(s.get("b")).toBe(99);
  });

  test("arrays overwrite rather than merge", () => {
    const s = new Store();
    s.put("list", [1, 2, 3]);
    s.merge({ list: [9] });
    expect(s.get("list")).toEqual([9]);
  });

  test("primitive over object (and object over primitive) overwrite", () => {
    const s = new Store();
    s.put("a", { nested: true });
    s.merge({ a: 5 });
    expect(s.get("a")).toBe(5);

    s.put("b", 1);
    s.merge({ b: { now: "object" } });
    expect(s.get("b")).toEqual({ now: "object" });
  });

  test("rejects unsafe keys anywhere in the merged tree", () => {
    const s = new Store();
    const hostile = JSON.parse('{"good":1,"__proto__":{"polluted":true}}');
    expect(() => s.merge(hostile)).toThrow(TypeError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("Store.version", () => {
  test("starts at 0 and increments on every mutation", () => {
    const s = new Store();
    expect(s.version).toBe(0);
    s.put("a", 1);
    expect(s.version).toBe(1);
    s.merge({ b: 2 });
    expect(s.version).toBe(2);
    s.delete("a");
    expect(s.version).toBe(3);
  });

  test("a no-op delete (absent path) does not bump the version", () => {
    const s = new Store();
    s.put("a", 1);
    const v = s.version;
    expect(s.delete("does.not.exist")).toBe(false);
    expect(s.version).toBe(v);
  });
});

describe("Store.asReadonly", () => {
  test("delegates get/version to the live store and is frozen", () => {
    const s = new Store();
    s.put("a", 1);
    const ro = s.asReadonly();
    expect(ro.get("a")).toBe(1);
    expect(ro.version).toBe(1);
    expect(Object.isFrozen(ro)).toBe(true);
    // The facade tracks the live store after subsequent mutations.
    s.put("b", 2);
    expect(ro.get("b")).toBe(2);
    expect(ro.version).toBe(2);
  });

  test("does not expose document or mutators", () => {
    const s = new Store();
    const ro = s.asReadonly() as unknown as Record<string, unknown>;
    expect(ro.document).toBeUndefined();
    expect(ro.put).toBeUndefined();
    expect(ro.delete).toBeUndefined();
    expect(ro.merge).toBeUndefined();
  });

  test("facade cannot corrupt the store; mutators stay on the Store itself", () => {
    const s = new Store();
    const ro = s.asReadonly() as unknown as Record<
      string,
      ((...a: unknown[]) => unknown) | undefined
    >;
    // A cast-and-call is a no-op since put is absent on the frozen facade.
    ro.put?.("x", 1);
    expect(s.get("x")).toBeUndefined();
    // The underlying Store is authoritative and still mutable.
    s.put("y", 2);
    expect(s.get("y")).toBe(2);
  });
});
