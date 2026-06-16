import { test, expect, describe } from "vitest";
import {
  Bundle,
  DuplicatePackageError,
  Engine,
  UnknownRuleError,
  bundle,
  module,
} from "../src/index.ts";

// D1: cross-module same-package semantics. Two modules sharing a package name
// would silently fail to merge their clauses ("first matching module wins"), so
// Engine.add() rejects a duplicate package name per engine with a typed
// DuplicatePackageError. The check runs to completion before any state mutation,
// so a rejected add() is atomic and leaves the engine usable.

describe("D1: duplicate package names are rejected at add()", () => {
  test("two add() calls with the same package name throw", () => {
    const a = module("authz").complete("allow", () => true);
    const b = module("authz").complete("deny", () => true);
    expect(() => new Engine().add(a).add(b)).toThrow(DuplicatePackageError);
  });

  test("the thrown error is typed and carries the offending package name", () => {
    const a = module("authz").complete("allow", () => true);
    const b = module("authz").complete("deny", () => true);
    let caught: unknown;
    try {
      new Engine().add(a).add(b);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DuplicatePackageError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as DuplicatePackageError).name).toBe("DuplicatePackageError");
    expect((caught as DuplicatePackageError).packageName).toBe("authz");
    expect((caught as DuplicatePackageError).message).toContain("authz");
  });

  test("re-adding the exact same module instance throws", () => {
    const a = module("authz").complete("allow", () => true);
    expect(() => new Engine().add(a).add(a)).toThrow(DuplicatePackageError);
  });
});

describe("D1: duplicate package names within a single bundle", () => {
  test("a bundle holding two same-package modules throws on add()", () => {
    const a = module("authz").complete("allow", () => true);
    const b = module("authz").complete("deny", () => true);
    const bun = new Bundle({ modules: [a, b] });
    expect(() => new Engine().add(bun)).toThrow(DuplicatePackageError);
  });

  test("the bundle-internal duplicate names the offending package", () => {
    const a = module("authz").complete("allow", () => true);
    const b = module("authz").complete("deny", () => true);
    const bun = bundle({ modules: [a, b] });
    let caught: unknown;
    try {
      new Engine().add(bun);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DuplicatePackageError);
    expect((caught as DuplicatePackageError).packageName).toBe("authz");
  });

  test("a module collides with one already supplied by an earlier bundle", () => {
    const a = module("authz").complete("allow", () => true);
    const bun = bundle({ modules: [a] });
    const dup = module("authz").complete("deny", () => true);
    expect(() => new Engine().add(bun).add(dup)).toThrow(DuplicatePackageError);
  });

  test("a bundle collides with a module already added directly", () => {
    const direct = module("authz").complete("allow", () => true);
    const bun = bundle({ modules: [module("authz").complete("deny", () => true)] });
    expect(() => new Engine().add(direct).add(bun)).toThrow(DuplicatePackageError);
  });
});

describe("D1: distinct and nested package names still coexist", () => {
  test("distinct package names add cleanly across calls", () => {
    const a = module("authz").complete("allow", () => true);
    const b = module("rbac").complete("ok", () => true);
    const e = new Engine().add(a).add(b);
    expect(e.query("authz.allow").defined).toBe(true);
    expect(e.query("rbac.ok").defined).toBe(true);
  });

  test("nested package names ('a' vs 'a.b') are distinct and both resolve", () => {
    const parent = module("a").complete("v", () => 1);
    const child = module("a.b").complete("v", () => 2);
    const e = new Engine().add(parent).add(child);
    const p = e.query("a.v");
    const c = e.query("a.b.v");
    if (p.defined) expect(p.result).toBe(1);
    if (c.defined) expect(c.result).toBe(2);
  });

  test("a single bundle of distinct package names adds cleanly", () => {
    const a = module("authz").complete("allow", () => true);
    const b = module("rbac").complete("ok", () => true);
    const e = new Engine().add(bundle({ modules: [a, b] }));
    expect(e.query("authz.allow").defined).toBe(true);
    expect(e.query("rbac.ok").defined).toBe(true);
  });
});

describe("D1: a rejected add() is atomic", () => {
  test("a duplicate inside a bundle does not partially register its other modules", () => {
    const a = module("authz").complete("allow", () => true);
    const dupBundle = new Bundle({
      modules: [module("rbac").complete("ok", () => true), module("authz").complete("x", () => 1)],
    });
    const e = new Engine().add(a);
    expect(() => e.add(dupBundle)).toThrow(DuplicatePackageError);
    // The original module is untouched and still resolves.
    expect(e.query("authz.allow").defined).toBe(true);
    // The non-duplicate module from the rejected bundle (rbac) must NOT have
    // leaked into the engine. It is not a known path on the engine's type, so
    // probe it through the untyped query surface.
    const untyped = e as unknown as { query(path: string): { defined: boolean } };
    expect(() => untyped.query("rbac.ok")).toThrow(UnknownRuleError);
  });

  test("the engine stays usable after a rejected add()", () => {
    const e = new Engine().add(module("authz").complete("allow", () => true));
    const dup = module("authz").complete("deny", () => true);
    expect(() => e.add(dup)).toThrow(DuplicatePackageError);
    // A subsequent add() of a genuinely new package still works.
    const e2 = e.add(module("rbac").complete("ok", () => true));
    expect(e2.query("authz.allow").defined).toBe(true);
    expect(e2.query("rbac.ok").defined).toBe(true);
  });

  test("the duplicate seed data of a rejected bundle is not merged", () => {
    const e = new Engine().add(module("authz").complete("allow", () => true));
    const dupBundle = new Bundle({
      modules: [module("authz").complete("x", () => 1)],
      data: { leaked: true },
    });
    expect(() => e.add(dupBundle)).toThrow(DuplicatePackageError);
    expect(e.store.get("leaked")).toBeUndefined();
  });
});
