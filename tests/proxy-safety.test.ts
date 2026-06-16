import { describe, expect, test } from "vitest";
import { Engine, module } from "../src/index.ts";

// The engine and ctx objects are wrapped in Proxies that turn unknown property
// accesses into callable package paths. Runtime hooks (then/catch/finally,
// toJSON/toString, any symbol) must NOT become package paths — otherwise
// `await engine` sees a callable `.then` and JSON.stringify recurses forever.

describe("engine proxy meta-prop safety", () => {
  test("await engine resolves to the engine (does not throw or hang)", async () => {
    const m = module("authz").complete("allow", () => true);
    const e = new Engine().add(m);
    // If `.then` were a callable package proxy, await would invoke query()
    // against a bogus path (and throw). It must resolve to `e` instead.
    const awaited = await e;
    expect(awaited).toBe(e as unknown as typeof awaited);
  });

  test("JSON.stringify(engine) does not throw", () => {
    const m = module("authz").complete("allow", () => true);
    const e = new Engine().add(m);
    // `.toJSON` must not be a callable proxy; serialization must terminate.
    expect(() => JSON.stringify(e)).not.toThrow();
  });

  test("String(engine) / template interpolation does not throw", () => {
    const m = module("authz").complete("allow", () => true);
    const e = new Engine().add(m);
    expect(() => `${e}`).not.toThrow();
    expect(() => String(e)).not.toThrow();
  });

  test("real rule access still works after the meta-prop guard", () => {
    const m = module("authz").complete("allow", () => 42);
    const e = new Engine().add(m);
    const d = e.authz.allow();
    expect(d.defined).toBe(true);
    if (d.defined) expect(d.result).toBe(42);
  });

  test("a rule literally named to collide with a meta-prop is unreachable via that name but query() works", () => {
    // The proxy guard short-circuits `then` so engine.<pkg>.then would not be a
    // package leaf — but the string query path still resolves the real rule.
    const m = module("p").complete("toJSON", () => "ok");
    const e = new Engine().add(m);
    const d = e.query("p.toJSON");
    if (d.defined) expect(d.result).toBe("ok");
  });
});

describe("ctx proxy meta-prop safety", () => {
  test("meta-props on ctx are undefined (not callable package proxies)", () => {
    let thenIsUndefined = false;
    let toJSONIsUndefined = false;
    const m = module("p").complete("v", (ctx) => {
      const c = ctx as unknown as Record<string, unknown>;
      // then/toJSON must NOT be turned into callable package proxies — otherwise
      // awaiting/serializing a ctx would dispatch a bogus call().
      thenIsUndefined = c["then"] === undefined;
      toJSONIsUndefined = c["toJSON"] === undefined;
      return "done";
    });
    const e = new Engine().add(m);
    const d = e.query("p.v");
    if (d.defined) expect(d.result).toBe("done");
    expect(thenIsUndefined).toBe(true);
    expect(toJSONIsUndefined).toBe(true);
  });

  test("JSON.stringify of ctx.input does not throw and round-trips", () => {
    const m = module("p").complete("v", (ctx) => {
      // ctx.input is a frozen plain snapshot; serialization must work.
      return JSON.stringify(ctx.input);
    });
    const e = new Engine().add(m);
    const d = e.query("p.v", { input: { a: 1, b: [2, 3] } });
    if (d.defined) expect(JSON.parse(d.result as string)).toEqual({ a: 1, b: [2, 3] });
  });
});
