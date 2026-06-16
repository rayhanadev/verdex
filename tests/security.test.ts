import { afterEach, describe, expect, test } from "vitest";
import { Engine, bundle, module } from "../src/index.ts";

// If a regression ever lets pollution through, make sure it can't leak across tests.
afterEach(() => {
  const proto = Object.prototype as Record<string, unknown>;
  delete proto["role"];
  delete proto["polluted"];
});

describe("prototype pollution guard", () => {
  test("engine.put refuses __proto__ path segments", () => {
    const e = new Engine();
    expect(() => e.put("__proto__.role", "admin")).toThrow(TypeError);
    expect(() => e.put("a.__proto__.b", 1)).toThrow(TypeError);
    expect(() => e.put("constructor.prototype.x", 1)).toThrow(TypeError);
    // Object.prototype is untouched.
    expect(({} as Record<string, unknown>).role).toBeUndefined();
  });

  test("a default-deny policy cannot be flipped via prototype pollution", () => {
    const rbac = module("rbac")
      .default("allow", false)
      .complete("allow", (ctx) =>
        (ctx.data as { role?: string }).role === "admin" ? true : undefined,
      );
    const e = new Engine().add(rbac);

    const before = e.query("rbac.allow");
    expect(before.defined && before.result).toBe(false);

    // The previously-working bypass now throws instead of poisoning the prototype.
    expect(() => e.put("__proto__.role", "admin")).toThrow(TypeError);
    expect(({} as Record<string, unknown>).role).toBeUndefined();

    const after = e.query("rbac.allow");
    expect(after.defined && after.result).toBe(false);
  });

  test("root document replacement rejects unsafe top-level keys", () => {
    const e = new Engine();
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => e.put("", hostile)).toThrow(TypeError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("bundle data merge rejects unsafe keys", () => {
    const m = module("p").complete("v", () => 1);
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    const b = bundle({ modules: [m], data: hostile });
    expect(() => new Engine().add(b)).toThrow(TypeError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("'with' override targets reject unsafe segments", () => {
    const m = module("p").complete("v", () => 1);
    const e = new Engine().add(m);
    expect(() =>
      e.query("p.v", { with: [{ target: "data.__proto__.role", value: "admin" }] }),
    ).toThrow(TypeError);
    expect(({} as Record<string, unknown>).role).toBeUndefined();
  });

  test("Store.get does not surface inherited prototype members", () => {
    (Object.prototype as Record<string, unknown>)["role"] = "admin";
    const m = module("p").complete("v", (ctx) =>
      // ctx.store.get must not read the inherited "role"
      ctx.store.get("role"),
    );
    const e = new Engine().add(m);
    const d = e.query("p.v");
    expect(d.defined).toBe(false);
  });
});
