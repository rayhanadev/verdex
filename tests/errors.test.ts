import { describe, expect, test } from "vitest";
import {
  AsyncSchemaError,
  ConflictError,
  Engine,
  OverrideError,
  PolicyError,
  RuleQueryError,
  module,
  type StandardSchemaV1,
} from "../src/index.ts";

// A minimal Standard Schema v1 whose validate() returns a thenable, to trip the
// engine's synchronous-only guard (AsyncSchemaError).
function asyncSchema(): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value: unknown) {
        return Promise.resolve({ value });
      },
    },
  };
}

// A synchronous pass-through schema, for contrast.
function syncSchema(): StandardSchemaV1<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value: unknown) {
        return { value };
      },
    },
  };
}

describe("AsyncSchemaError", () => {
  test("thenable-returning input schema throws AsyncSchemaError", () => {
    const m = module("p", { input: asyncSchema() }).complete("v", () => true);
    const e = new Engine().add(m);
    expect(() => e.query("p.v", { input: {} })).toThrow(AsyncSchemaError);
  });

  test("AsyncSchemaError is a PolicyError and carries the subject + name", () => {
    const m = module("p", { input: asyncSchema() }).complete("v", () => true);
    const e = new Engine().add(m);
    try {
      e.query("p.v", { input: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyError);
      expect(err).toBeInstanceOf(AsyncSchemaError);
      const ase = err as AsyncSchemaError;
      expect(ase.name).toBe("AsyncSchemaError");
      expect(ase.subject).toContain("p");
      // The message must NOT leak validated values; it describes the async issue.
      expect(ase.message).toContain("async");
    }
  });

  test("a synchronous schema does not throw AsyncSchemaError", () => {
    const m = module("p", { input: syncSchema() }).complete("v", () => true);
    const e = new Engine().add(m);
    expect(() => e.query("p.v", { input: {} })).not.toThrow();
  });
});

describe("RuleQueryError", () => {
  test("querying a func rule directly throws RuleQueryError (a PolicyError)", () => {
    const m = module("p").func("f", () => 1);
    const e = new Engine().add(m);
    let caught: unknown;
    try {
      (e.query as (p: string) => unknown)("p.f");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RuleQueryError);
    expect(caught).toBeInstanceOf(PolicyError);
    expect((caught as RuleQueryError).name).toBe("RuleQueryError");
  });

  test("ctx.call on a non-function rule throws RuleQueryError", () => {
    const m = module("p").complete("notAFunc", () => 1);
    const caller = module("c").complete("v", (ctx) => {
      // Call a complete rule as if it were a function — must throw RuleQueryError.
      (ctx.call as (path: string, ...args: unknown[]) => unknown)("p.notAFunc");
      return true;
    });
    const e = new Engine().add(m).add(caller);
    let caught: unknown;
    try {
      e.query("c.v");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RuleQueryError);
  });
});

describe("OverrideError", () => {
  test("an invalid 'with' target (not input/data) throws OverrideError", () => {
    const m = module("p").complete("v", () => 1);
    const e = new Engine().add(m);
    let caught: unknown;
    try {
      e.query("p.v", { with: [{ target: "bogus.path", value: 1 }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OverrideError);
    expect(caught).toBeInstanceOf(PolicyError);
    expect((caught as OverrideError).name).toBe("OverrideError");
  });

  test("valid input/data targets do not throw OverrideError", () => {
    const m = module("p").complete("v", (ctx) => (ctx.input as { x: number }).x);
    const e = new Engine().add(m);
    expect(() =>
      e.query("p.v", {
        input: { x: 1 },
        with: [{ target: "input.x", value: 2 }],
      }),
    ).not.toThrow();
  });
});

describe("ConflictError does not leak secrets", () => {
  test("message references the rule path + count, not the raw values; .values still holds them", () => {
    const secretA = { token: "SECRET-AAAA", pin: 1234 };
    const secretB = { token: "SECRET-BBBB", pin: 5678 };
    const m = module("authz")
      .complete("allow", (): unknown => secretA)
      .complete("allow", (): unknown => secretB);
    const e = new Engine().add(m);
    let caught: ConflictError | undefined;
    try {
      e.query("authz.allow");
    } catch (err) {
      caught = err as ConflictError;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const ce = caught!;
    // The message must NOT contain the raw secret payloads.
    expect(ce.message).not.toContain("SECRET-AAAA");
    expect(ce.message).not.toContain("SECRET-BBBB");
    expect(ce.message).not.toContain("1234");
    // But it should reference the rule path and the count of distinct results.
    expect(ce.message).toContain("authz.allow");
    expect(ce.message).toContain("2");
    expect(ce.rulePath).toBe("authz.allow");
    // The full values remain available on the public readonly .values property.
    expect(ce.values).toEqual([secretA, secretB]);
  });
});
