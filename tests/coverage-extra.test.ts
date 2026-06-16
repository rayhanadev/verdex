import { describe, expect, test } from "vitest";
import { ConflictError, Engine, RuleKindMismatchError, module } from "../src/index.ts";

// Two complete rules returning distinct objects exercise eq() deeply: equal content
// merges to one decision; unequal content throws ConflictError.
function twoComplete(a: unknown, b: unknown) {
  const m = module("p")
    .complete("v", (): unknown => a)
    .complete("v", (): unknown => b);
  return new Engine().add(m).query("p.v");
}

describe("deep equality — exotic container types", () => {
  test("RegExp: equal source+flags merge, differing flags conflict", () => {
    expect(twoComplete(/x/gi, /x/gi).defined).toBe(true);
    expect(() => twoComplete(/x/g, /x/i)).toThrow(ConflictError);
  });

  test("Map: equal merge; size and value mismatches conflict", () => {
    expect(twoComplete(new Map([["a", 1]]), new Map([["a", 1]])).defined).toBe(true);
    expect(() =>
      twoComplete(
        new Map([["a", 1]]),
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).toThrow(ConflictError);
    expect(() => twoComplete(new Map([["a", 1]]), new Map([["a", 2]]))).toThrow(ConflictError);
  });

  test("Set: deep-membership equal merge; mismatch conflicts", () => {
    expect(twoComplete(new Set([1, 2]), new Set([2, 1])).defined).toBe(true);
    expect(() => twoComplete(new Set([1, 2]), new Set([1, 3]))).toThrow(ConflictError);
  });

  test("typed arrays: equal merge; differing length/element conflict", () => {
    expect(twoComplete(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])).defined).toBe(true);
    expect(() => twoComplete(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toThrow(
      ConflictError,
    );
    expect(() => twoComplete(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toThrow(
      ConflictError,
    );
  });

  test("DataView: equal bytes merge; differing bytes/length conflict", () => {
    const mk = (bytes: number[]) => {
      const dv = new DataView(new ArrayBuffer(bytes.length));
      bytes.forEach((b, i) => dv.setUint8(i, b));
      return dv;
    };
    expect(twoComplete(mk([1, 2]), mk([1, 2])).defined).toBe(true);
    expect(() => twoComplete(mk([1, 2]), mk([1, 9]))).toThrow(ConflictError);
    expect(() => twoComplete(mk([1, 2]), mk([1, 2, 3]))).toThrow(ConflictError);
  });
});

describe("RuleKindMismatchError", () => {
  test("redeclaring a rule with a different kind throws", () => {
    expect(() =>
      module("p")
        .complete("v", () => 1)
        .set("v", function* () {
          yield 1;
        }),
    ).toThrow(RuleKindMismatchError);
  });

  test("declaring a func rule twice throws", () => {
    expect(() =>
      module("p")
        .func("f", () => 1)
        .func("f", () => 2),
    ).toThrow(RuleKindMismatchError);
  });
});

describe("package proxy toString label", () => {
  test("String(engine.<pkg>) and nested paths yield proxy labels", () => {
    const e = new Engine().add(module("authz").complete("allow", () => true));
    expect(String(e.authz)).toBe("[Proxy authz]");
    expect(String(e.authz.allow)).toBe("[Proxy authz.allow]");
  });
});
