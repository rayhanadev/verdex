import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { Engine, PolicyError, UnsafeKeyError, bundle, module, snapshot } from "../src/index.ts";

// Regression tests for the 0.2 snapshot bypass: deepClone copied an own
// "__proto__" key with plain assignment, which *set the clone's prototype*. A rule
// reading a missing field then saw an attacker-chosen inherited value — e.g.
// {"user":{"__proto__":{"role":"admin"}}} flipped a default-deny policy to allow.

afterEach(() => {
  const proto = Object.prototype as Record<string, unknown>;
  delete proto["role"];
  delete proto["polluted"];
});

const hostileInput = () => JSON.parse('{"user":{"name":"mallory","__proto__":{"role":"admin"}}}');

// The exact policy from the proof of concept: no input schema, default deny.
const authz = module("authz")
  .default("allow", false)
  .when("allow", (ctx) => (ctx.input as { user: { role?: string } }).user.role === "admin");

describe("input snapshots", () => {
  test("an own __proto__ key in input is rejected, not used as a prototype", () => {
    const e = new Engine().add(authz);
    expect(() => e.authz.allow({ input: hostileInput() })).toThrow(UnsafeKeyError);
    const r = e.authz.allow.evaluate({ input: hostileInput() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(UnsafeKeyError);
      expect(r.error).toBeInstanceOf(PolicyError);
      expect((r.error as UnsafeKeyError).key).toBe("__proto__");
      expect((r.error as UnsafeKeyError).subject).toBe("input");
    }
    expect(({} as { role?: string }).role).toBeUndefined();
  });

  test("unsafeKeys: 'drop' removes the key and keeps the default-deny decision", () => {
    const e = new Engine({ unsafeKeys: "drop" }).add(authz);
    expect(e.authz.allow({ input: hostileInput() })).toEqual({ defined: true, result: false });
    let seen: unknown;
    const probe = new Engine({ unsafeKeys: "drop" }).add(
      module("p").complete("v", (ctx) => {
        seen = ctx.input;
        return true;
      }),
    );
    probe.p.v({ input: hostileInput() });
    expect(Object.getPrototypeOf((seen as { user: object }).user)).toBe(Object.prototype);
    expect(Object.keys((seen as { user: object }).user)).toEqual(["name"]);
  });

  test("a caller-frozen hostile input is still rejected", () => {
    const e = new Engine().add(authz);
    const frozen = Object.freeze(hostileInput());
    Object.freeze(frozen.user);
    expect(() => e.authz.allow({ input: frozen })).toThrow(UnsafeKeyError);
  });

  test("constructor and prototype keys are rejected too", () => {
    const m = module("p").complete("v", () => true);
    const e = new Engine().add(m);
    for (const key of ["constructor", "prototype"]) {
      const input = JSON.parse(`{"a":{"${key}":{"x":1}}}`);
      expect(() => e.p.v({ input })).toThrow(UnsafeKeyError);
    }
  });

  test("unsafe keys inside arrays are found", () => {
    const e = new Engine().add(authz);
    const input = JSON.parse('{"user":{},"list":[{"ok":1},{"__proto__":{"role":"admin"}}]}');
    expect(() => e.authz.allow({ input })).toThrow(UnsafeKeyError);
  });

  test("a zod input schema strips the key before the snapshot (unchanged)", () => {
    const safe = module("safe", {
      input: z.object({ user: z.object({ name: z.string(), role: z.string().optional() }) }),
    })
      .default("allow", false)
      .when("allow", (ctx) => ctx.input.user.role === "admin");
    const e = new Engine().add(safe);
    expect(e.safe.allow({ input: hostileInput() })).toEqual({ defined: true, result: false });
  });

  test("snapshot() rejects unsafe keys", () => {
    expect(() => snapshot(hostileInput())).toThrow(UnsafeKeyError);
  });
});

describe("data snapshots", () => {
  const viaData = module("viadata")
    .default("allow", false)
    .when(
      "allow",
      (ctx) => (ctx.data as { users: { u1: { role?: string } } }).users.u1.role === "admin",
    );

  test("engine.put rejects unsafe keys nested inside the value (TypeError, like 0.2 put paths)", () => {
    const e = new Engine().add(viaData);
    expect(() => e.put("users", JSON.parse('{"u1":{"__proto__":{"role":"admin"}}}'))).toThrow(
      TypeError,
    );
    expect(e.viadata.allow.evaluate().ok).toBe(false); // users is still missing
    expect(({} as { role?: string }).role).toBeUndefined();
  });

  test("Store.merge and bundle data reject unsafe keys at any depth", () => {
    const hostile = JSON.parse('{"users":{"u1":{"__proto__":{"role":"admin"}}}}');
    expect(() => new Engine().add(bundle({ modules: [viaData], data: hostile }))).toThrow(
      TypeError,
    );
    const e = new Engine().add(viaData);
    expect(() => e.store.merge(hostile)).toThrow(TypeError);
    // A rejected merge is atomic: nothing was written.
    expect(e.store.get("users")).toBeUndefined();
  });

  test("per-query data and withData documents are checked", () => {
    const e = new Engine().add(viaData);
    const doc = () => JSON.parse('{"users":{"u1":{"__proto__":{"role":"admin"}}}}');
    expect(() => e.viadata.allow({ data: doc() })).toThrow(UnsafeKeyError);
    expect(() => e.withData(doc())).toThrow(UnsafeKeyError);
    const dropping = new Engine({ unsafeKeys: "drop" }).add(viaData);
    expect(dropping.viadata.allow({ data: doc() })).toEqual({ defined: true, result: false });
    expect(dropping.withData(doc()).viadata.allow()).toEqual({ defined: true, result: false });
  });

  test("`with` values are snapshotted like the documents they land in", () => {
    const e = new Engine().add(authz);
    const value = JSON.parse('{"__proto__":{"role":"admin"}}');
    expect(() =>
      e.authz.allow({ input: { user: {} }, with: [{ target: "input.user", value }] }),
    ).toThrow(UnsafeKeyError);
  });
});

describe("object rule results", () => {
  const byName = module("idx").object("byName", function* (ctx) {
    for (const [k, v] of ctx.input as [string, unknown][]) yield [k, v];
  });

  test("an unsafe key yielded by an object rule is rejected, or dropped", () => {
    const input = [
      ["a", 1],
      ["__proto__", { polluted: true }],
    ];
    expect(() => new Engine().add(byName).idx.byName({ input })).toThrow(UnsafeKeyError);
    const d = new Engine({ unsafeKeys: "drop" }).add(byName).idx.byName({ input });
    expect(d).toEqual({ defined: true, result: { a: 1 } });
    if (d.defined) expect(Object.getPrototypeOf(d.result)).toBe(Object.prototype);
  });

  test("inherited names such as toString are ordinary keys (no false conflict)", () => {
    const d = new Engine().add(byName).idx.byName({
      input: [
        ["toString", 1],
        ["hasOwnProperty", 2],
      ],
    });
    expect(d).toEqual({ defined: true, result: { toString: 1, hasOwnProperty: 2 } });
  });
});
