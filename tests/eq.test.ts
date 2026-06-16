import { describe, expect, test } from "vitest";
import { ConflictError, Engine, module } from "../src/index.ts";

// The deep-equality routine (`eq` in evaluator.ts) is private, so we exercise it
// only through observable engine behavior: conflicting complete rules (eq false =>
// throw) and set dedup (eq true => collapsed to one member).

// A complete rule whose two clauses both return `value` (a fresh instance each
// time) is defined and conflict-free iff eq() treats the two instances as equal.
function completeDefined(makeValue: () => unknown): boolean {
  const m = module("p")
    .complete("v", () => makeValue())
    .complete("v", () => makeValue());
  const d = new Engine().add(m).query("p.v");
  return d.defined;
}

// A complete rule whose two clauses return two *distinct* values throws iff eq()
// treats them as unequal.
function completeConflicts(a: unknown, b: unknown): boolean {
  const m = module("p")
    .complete("v", (): unknown => a)
    .complete("v", (): unknown => b);
  const e = new Engine().add(m);
  try {
    e.query("p.v");
    return false;
  } catch (err) {
    return err instanceof ConflictError;
  }
}

// A set rule yielding `a` then `b`; result length reveals whether eq() deduped.
function setResult(a: unknown, b: unknown): unknown[] {
  const m = module("p").set("s", function* () {
    yield a;
    yield b;
  });
  const d = new Engine().add(m).query("p.s");
  if (!d.defined) throw new Error("set rule should always be defined");
  return d.result as unknown[];
}

describe("eq via complete-rule conflict detection", () => {
  test("two equal Dates do not conflict", () => {
    expect(completeDefined(() => new Date(0))).toBe(true);
  });

  test("new Date(0) vs new Date(1) conflict (ConflictError)", () => {
    expect(completeConflicts(new Date(0), new Date(1))).toBe(true);
  });

  test("NaN is treated equal to NaN (no conflict)", () => {
    expect(completeConflicts(NaN, NaN)).toBe(false);
    expect(completeDefined(() => NaN)).toBe(true);
  });

  test("+0 and -0 are not equal (conflict)", () => {
    expect(completeConflicts(0, -0)).toBe(true);
  });

  test("an object is not equal to an array (conflict)", () => {
    // {0:'a',1:'b'} vs ['a','b'] — same keys, different kind.
    expect(completeConflicts({ 0: "a", 1: "b" }, ["a", "b"])).toBe(true);
  });

  test("equal RegExps do not conflict; differing flags conflict", () => {
    expect(completeDefined(() => /abc/gi)).toBe(true);
    expect(completeConflicts(/abc/g, /abc/i)).toBe(true);
    expect(completeConflicts(/abc/g, /abd/g)).toBe(true);
  });

  test("equal Maps do not conflict; differing Maps conflict", () => {
    expect(
      completeDefined(
        () =>
          new Map<string, number>([
            ["a", 1],
            ["b", 2],
          ]),
      ),
    ).toBe(true);
    expect(completeConflicts(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(true);
  });

  test("equal Sets do not conflict regardless of order", () => {
    expect(completeDefined(() => new Set([1, 2, 3]))).toBe(true);
    // Order-independent deep membership.
    expect(completeConflicts(new Set([1, 2, 3]), new Set([3, 2, 1]))).toBe(false);
    expect(completeConflicts(new Set([1, 2]), new Set([1, 2, 3]))).toBe(true);
  });

  test("nested plain objects compare deeply", () => {
    expect(completeDefined(() => ({ a: { b: [1, 2, { c: 3 }] } }))).toBe(true);
    expect(completeConflicts({ a: { b: [1, 2, { c: 3 }] } }, { a: { b: [1, 2, { c: 4 }] } })).toBe(
      true,
    );
  });
});

describe("eq via set-rule dedup", () => {
  test("two equal Dates dedup to one member", () => {
    const r = setResult(new Date(0), new Date(0));
    expect(r.length).toBe(1);
  });

  test("two unequal Dates keep both members", () => {
    const r = setResult(new Date(0), new Date(1));
    expect(r.length).toBe(2);
  });

  test("two NaN members dedup to one", () => {
    const r = setResult(NaN, NaN);
    expect(r.length).toBe(1);
  });

  test("deeply-equal objects dedup; differing objects do not", () => {
    expect(setResult({ x: [1, 2] }, { x: [1, 2] }).length).toBe(1);
    expect(setResult({ x: [1, 2] }, { x: [1, 3] }).length).toBe(2);
  });

  test("object and array with same keys are not deduped", () => {
    const r = setResult({ 0: "a" }, ["a"]);
    expect(r.length).toBe(2);
  });
});
