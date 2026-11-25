import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ConflictError, Engine, RuleQueryError, UnknownRuleError, module } from "../src/index.ts";

describe("compile()", () => {
  const authz = module("authz", { input: z.object({ role: z.string() }) })
    .default("allow", false)
    .when("allow", (ctx) => ctx.input.role === "admin", true, { id: "admin" })
    .complete("maybe", (ctx) => (ctx.input.role === "x" ? 1 : undefined))
    .func("f", () => 1);

  test("returns a direct callable with evaluate, explain and decide members", () => {
    const e = new Engine().add(authz);
    const allow = e.compile("authz.allow");
    expect(allow({ input: { role: "admin" } })).toEqual({ defined: true, result: true });
    expect(allow.decide({ input: { role: "guest" } })).toBe(false);
    expect(allow.evaluate({ input: { role: "admin" } })).toEqual({
      ok: true,
      decision: { defined: true, result: true },
    });
    expect(allow.explain({ input: { role: "admin" } }).clauses[0]).toEqual({
      index: 0,
      id: "admin",
      matched: true,
      value: true,
    });
    expect(Object.isFrozen(allow)).toBe(true);
  });

  test("fails fast for unknown and function paths", () => {
    const e = new Engine().add(authz);
    expect(() => (e.compile as (p: string) => unknown)("authz.nope")).toThrow(UnknownRuleError);
    expect(() => (e.compile as (p: string) => unknown)("authz.f")).toThrow(RuleQueryError);
  });

  test("reads the engine's store at call time", () => {
    const m = module("r").complete("v", (ctx) => (ctx.data as { v?: number }).v);
    const e = new Engine().add(m);
    const v = e.compile("r.v");
    expect(v()).toEqual({ defined: false });
    e.put("v", 1);
    expect(v()).toEqual({ defined: true, result: 1 });
  });

  test("proxy handles are cached per engine and equal the compiled behavior", () => {
    const e = new Engine().add(authz);
    expect(e.authz).toBe(e.authz);
    expect(e.authz.allow).toBe(e.authz.allow);
    expect(e.authz.allow.evaluate).toBe(e.authz.allow.evaluate);
    expect(e.authz.allow({ input: { role: "admin" } })).toEqual(
      e.compile("authz.allow")({ input: { role: "admin" } }),
    );
    // Unknown paths are not cached, so arbitrary property names cannot grow memory.
    const loose = e as unknown as Record<string, Record<string, unknown>>;
    expect(loose.nope).not.toBe(loose.nope);
    expect(loose.authz!.nope).not.toBe(loose.authz!.nope);
  });

  test("symbol and meta properties on handles are not package paths", () => {
    const e = new Engine().add(authz);
    const handle = e.authz.allow as unknown as Record<PropertyKey, unknown>;
    expect(handle[Symbol.iterator]).toBeUndefined();
    expect(handle.then).toBeUndefined();
    expect(String(e.authz.maybe)).toBe("[Proxy authz.maybe]");
  });
});

describe("set results dedupe with a native Set for primitives", () => {
  const many = (items: unknown[]) =>
    new Engine()
      .add(
        module("p").set("s", function* () {
          yield* items;
        }),
      )
      .decide("p.s");

  test("large primitive sets keep first-seen order and drop duplicates", () => {
    const items = Array.from({ length: 1000 }, (_, i) => `m${i % 600}`);
    const out = many(items) as string[];
    expect(out).toHaveLength(600);
    expect(out[0]).toBe("m0");
    expect(out[599]).toBe("m599");
  });

  test("keeps the deep-equality semantics: NaN dedupes, +0 and -0 stay distinct, objects compare deeply", () => {
    const small = many([NaN, NaN, 0, -0, -0, "a", { x: 1 }, { x: 1 }, { x: 2 }]) as unknown[];
    // NaN, 0, -0, "a", { x: 1 }, { x: 2 }
    expect(small).toHaveLength(6);
    expect(Number.isNaN(small[0])).toBe(true);
    expect(Object.is(small[1], 0)).toBe(true);
    expect(Object.is(small[2], -0)).toBe(true);
    const big = many([
      ...Array.from({ length: 20 }, (_, i) => i),
      NaN,
      NaN,
      -0,
      0,
      -0,
      null,
      undefined,
      null,
      true,
      true,
      { k: 1 },
      { k: 1 },
    ]) as unknown[];
    // 0..19, NaN, -0, null, undefined, true, { k: 1 }  (0 is already in 0..19)
    expect(big).toHaveLength(26);
  });

  test("members from several clauses are unioned", () => {
    const m = module("p")
      .set("s", function* () {
        for (let i = 0; i < 10; i++) yield i;
      })
      .set("s", function* () {
        for (let i = 5; i < 15; i++) yield i;
      });
    expect(new Engine().add(m).decide("p.s")).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });
});

describe("rules() introspection and metadata", () => {
  const docs = module("docs", {
    version: 2,
    description: "Document access",
    see: "AGENTS.md#documents",
    meta: { owner: "platform" },
  })
    .func("isOwner", () => true, { description: "Viewer owns the document." })
    .default("edit", false, { description: "Whether the viewer can edit.", see: ["a", "b"] })
    .when("edit", (ctx) => ctx.docs.isOwner(), true, { id: "owner", meta: { audit: true } })
    .when("edit", () => false, true, { id: "never", meta: { tier: 1 } })
    .contains("why", () => true, "x", { see: "c" })
    .object("index", function* () {});

  test("lists every rule with kind, default, clauses, ids and merged metadata", () => {
    const rules = new Engine().add(docs).rules();
    expect(rules.map((r) => [r.path, r.kind, r.hasDefault, r.clauses])).toEqual([
      ["docs.isOwner", "func", false, 1],
      ["docs.edit", "complete", true, 2],
      ["docs.why", "set", false, 1],
      ["docs.index", "object", false, 1],
    ]);
    const edit = rules[1]!;
    expect(edit.ids).toEqual(["owner", "never"]);
    expect(edit.description).toBe("Whether the viewer can edit.");
    expect(edit.see).toEqual(["a", "b"]);
    expect(edit.meta).toEqual({ audit: true, tier: 1 });
    expect(rules[0]!.description).toBe("Viewer owns the document.");
    expect(rules[2]!.see).toEqual(["c"]);
    expect(rules[3]!.see).toEqual([]);
    expect("description" in rules[3]!).toBe(false);
    expect(edit.module).toEqual({
      package: "docs",
      version: 2,
      description: "Document access",
      see: ["AGENTS.md#documents"],
      meta: { owner: "platform" },
      fingerprint: expect.stringMatching(/^[0-9a-f]{28}$/),
    });
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(edit)).toBe(true);
  });

  test("includes default-only rules and keeps module-add order", () => {
    const a = module("a").default("only", 1);
    const b = module("b").complete("v", () => 1);
    const rules = new Engine().add(b).add(a).rules();
    expect(rules.map((r) => [r.path, r.kind, r.clauses])).toEqual([
      ["b.v", "complete", 1],
      ["a.only", "complete", 0],
    ]);
    expect(rules[1]!.module).toEqual({
      package: "a",
      see: [],
      meta: {},
      fingerprint: expect.any(String),
    });
  });

  test("module metadata is readable on the module itself", () => {
    expect(docs.version).toBe(2);
    expect(docs.description).toBe("Document access");
    expect(docs.see).toEqual(["AGENTS.md#documents"]);
    expect(docs.meta).toEqual({ owner: "platform" });
    expect(docs.getMeta("edit")?.description).toBe("Whether the viewer can edit.");
    expect(docs.getMeta("index")).toBeUndefined();
    expect(module("x", { see: ["one", "two"] }).see).toEqual(["one", "two"]);
  });

  test("a rule declared at the root package resolves by its bare name", () => {
    const root = module("").default("flag", true);
    const e = new Engine().add(root);
    expect((e.query as (p: string) => unknown)("flag")).toEqual({ defined: true, result: true });
    expect(e.rules()[0]!.path).toBe("flag");
  });

  test("object rules still detect conflicting values for a key", () => {
    const m = module("p")
      .object("o", function* () {
        yield ["k", 1];
      })
      .object("o", function* () {
        yield ["k", 2];
      });
    expect(() => new Engine().add(m).p.o()).toThrow(ConflictError);
  });
});
