import { describe, expect, test } from "vitest";
import { z } from "zod";
import { Engine, ValidationError, module, snapshot, type StandardSchemaV1 } from "../src/index.ts";

// A Standard Schema that counts its validate() calls, to observe caching.
function counting<T>(inner: StandardSchemaV1<unknown, T>) {
  const counter = { calls: 0 };
  const schema: StandardSchemaV1<unknown, T> = {
    "~standard": {
      version: 1,
      vendor: "counting",
      validate(value: unknown) {
        counter.calls++;
        return inner["~standard"].validate(value);
      },
    },
  };
  return { schema, counter };
}

const Roles = module("roles")
  .default("admin", false)
  .when("admin", (ctx) => ((ctx.data as { roles?: string[] }).roles ?? []).includes("admin"));

describe("per-query data", () => {
  test("replaces the store document for one query only", () => {
    const e = new Engine().add(Roles).put("roles", ["admin"]);
    expect(e.roles.admin({ data: { roles: [] } })).toEqual({ defined: true, result: false });
    expect(e.roles.admin()).toEqual({ defined: true, result: true });
  });

  test("concurrent requests with per-query data never see each other's facts", async () => {
    const shared = new Engine().add(Roles);
    async function request(roles: string[], delay: number) {
      const data = { roles };
      await new Promise((r) => setTimeout(r, delay));
      return shared.roles.admin({ data });
    }
    const [organizer, admin] = await Promise.all([
      request(["organizer"], 15),
      request(["admin"], 0),
    ]);
    expect(organizer).toEqual({ defined: true, result: false });
    expect(admin).toEqual({ defined: true, result: true });
  });

  test("is snapshotted: rules see a frozen copy and the caller's object stays mutable", () => {
    let frozen = false;
    const m = module("p").complete("v", (ctx) => {
      frozen = Object.isFrozen(ctx.data);
      return true;
    });
    const data = { a: { b: 1 } };
    new Engine().add(m).p.v({ data });
    expect(frozen).toBe(true);
    expect(Object.isFrozen(data)).toBe(false);
  });

  test("with overrides apply on top of per-query data", () => {
    const m = module("p").complete("v", (ctx) => (ctx.data as { x: number }).x);
    const e = new Engine().add(m);
    expect(e.p.v({ data: { x: 1 }, with: [{ target: "data.x", value: 2 }] })).toEqual({
      defined: true,
      result: 2,
    });
  });

  test("is validated against the module's data schema", () => {
    const m = module("p", { data: z.object({ n: z.number() }) }).complete("v", (ctx) => ctx.data.n);
    const e = new Engine().add(m);
    expect(() => e.p.v({ data: { n: "x" as unknown as number } })).toThrow(ValidationError);
    expect(e.p.v({ data: { n: 3 } })).toEqual({ defined: true, result: 3 });
  });
});

describe("withData()", () => {
  test("returns a new engine view; the original engine is unchanged", () => {
    const e = new Engine().add(Roles).put("roles", ["admin"]);
    const view = e.withData({ roles: ["member"] });
    expect(view).not.toBe(e);
    expect(view.roles.admin()).toEqual({ defined: true, result: false });
    expect(e.roles.admin()).toEqual({ defined: true, result: true });
    expect(view.store.get("roles")).toEqual(["member"]);
    expect(view.fingerprint()).toBe(e.fingerprint());
  });

  test("rejects a non-object document", () => {
    const e = new Engine().add(Roles);
    expect(() => e.withData([] as unknown as object)).toThrow(TypeError);
    expect(() => e.withData(null as unknown as object)).toThrow(TypeError);
  });

  test("uses a deep-frozen document as-is and flattens a non-plain one", () => {
    const doc = snapshot({ roles: ["admin"] });
    const view = new Engine().add(Roles).withData(doc);
    expect(view.store.document).toBe(doc);
    class Doc {
      roles = ["admin"];
    }
    const flat = new Engine().add(Roles).withData(new Doc());
    expect(flat.roles.admin()).toEqual({ defined: true, result: true });
  });
});

describe("data validation is cached per document", () => {
  test("a store document is validated once per version, not once per query", () => {
    const { schema, counter } = counting(z.object({ limit: z.number() }));
    const m = module("p", { data: schema }).complete("v", (ctx) => ctx.data.limit);
    const e = new Engine().add(m).put("limit", 5);
    for (let i = 0; i < 10; i++) expect(e.p.v()).toEqual({ defined: true, result: 5 });
    expect(counter.calls).toBe(1);
    e.put("limit", 6); // a write makes a new document, so it is validated again
    for (let i = 0; i < 10; i++) expect(e.p.v()).toEqual({ defined: true, result: 6 });
    expect(counter.calls).toBe(2);
  });

  test("a deep-frozen per-query document is validated once per identity", () => {
    const { schema, counter } = counting(z.object({ limit: z.number() }));
    const m = module("p", { data: schema }).complete("v", (ctx) => ctx.data.limit);
    const e = new Engine().add(m);
    const doc = snapshot({ limit: 7 });
    for (let i = 0; i < 5; i++) e.p.v({ data: doc });
    expect(counter.calls).toBe(1);
    // A fresh (unfrozen) object is copied and validated on every query.
    for (let i = 0; i < 3; i++) e.p.v({ data: { limit: 7 } });
    expect(counter.calls).toBe(4);
  });

  test("the validated output is shared across modules that use the same schema", () => {
    const { schema, counter } = counting(z.object({ limit: z.number() }));
    const a = module("a", { data: schema }).complete("v", (ctx) => ctx.data.limit);
    const b = module("b", { data: schema }).complete("v", (ctx) => ctx.data.limit * 2);
    const e = new Engine().add(a).add(b).put("limit", 2);
    expect(e.a.v()).toEqual({ defined: true, result: 2 });
    expect(e.b.v()).toEqual({ defined: true, result: 4 });
    expect(counter.calls).toBe(1);
  });

  test("drop mode keeps its own cache (a schema output is snapshotted per mode)", () => {
    const { schema, counter } = counting(z.looseObject({ limit: z.number() }));
    const m = module("p", { data: schema }).complete("v", (ctx) => ctx.data.limit);
    const doc = snapshot({ limit: 1 });
    new Engine().add(m).p.v({ data: doc });
    new Engine({ unsafeKeys: "drop" }).add(m).p.v({ data: doc });
    expect(counter.calls).toBe(2);
  });
});

describe("input snapshots skip work for deep-frozen input", () => {
  test("a deep-frozen input reaches rules by reference (no copy)", () => {
    let seen: unknown;
    const m = module("p").complete("v", (ctx) => {
      seen = ctx.input;
      return true;
    });
    const e = new Engine().add(m);
    const input = snapshot({ viewer: { id: "u1", roles: ["admin"] } });
    e.p.v({ input });
    expect(seen).toBe(input);
    const handFrozen = Object.freeze({ a: Object.freeze([1, 2]) });
    e.p.v({ input: handFrozen });
    expect(seen).toBe(handFrozen);
  });

  test("a partly frozen input is copied, and the caller's objects are never frozen", () => {
    let seen: { a: { b: number } } | undefined;
    const m = module("p").complete("v", (ctx) => {
      seen = ctx.input as { a: { b: number } };
      return true;
    });
    const inner = { b: 1 };
    const input = Object.freeze({ a: inner });
    new Engine().add(m).p.v({ input });
    expect(seen).not.toBe(input);
    expect(Object.isFrozen(seen!.a)).toBe(true);
    expect(Object.isFrozen(inner)).toBe(false);
  });

  test("snapshot() returns an equal deep-frozen copy, and the same value when already frozen", () => {
    const original = { a: [1, { b: 2 }], when: new Date(0) };
    const frozen = snapshot(original);
    expect(frozen).toEqual(original);
    expect(frozen).not.toBe(original);
    expect(Object.isFrozen(frozen.a[1])).toBe(true);
    expect(Object.isFrozen(original.a)).toBe(false);
    expect(snapshot(frozen)).toBe(frozen);
    expect(snapshot(5)).toBe(5);
    expect(snapshot(null)).toBe(null);
  });

  test("schema-less modules in one query share one input snapshot", () => {
    const seen: unknown[] = [];
    const a = module("a").func("peek", (ctx) => {
      seen.push(ctx.input);
      return true;
    });
    const b = module("b").complete("v", (ctx) => {
      seen.push(ctx.input);
      return ctx.call("a.peek") as boolean;
    });
    new Engine()
      .add(a)
      .add(b)
      .b.v({ input: { x: 1 } });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});
