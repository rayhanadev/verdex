import { describe, expect, test } from "vitest";
import { Engine, RESERVED, module } from "../src/index.ts";

describe("reserved package roots", () => {
  test("RESERVED is exactly the documented set", () => {
    expect([...RESERVED].toSorted()).toEqual(
      [
        "add",
        "call",
        "constructor",
        "data",
        "input",
        "modules",
        "put",
        "query",
        "store",
      ].toSorted(),
    );
  });

  test("module() throws a clear /reserved/ error for every reserved root", () => {
    for (const name of RESERVED) {
      expect(() => module(name)).toThrow(/reserved/);
    }
  });

  test('module("modules") throws (the previously-silent engine-field footgun)', () => {
    // `modules` is EngineImpl's private field; before D3 a package named
    // "modules" would be shadowed by it instead of routing through the proxy.
    expect(() => module("modules")).toThrow(/reserved/);
    expect(() => module("modules.nested")).toThrow(/reserved/);
  });

  test("previously-reserved ctx/engine member names still throw", () => {
    expect(() => module("input")).toThrow(/reserved/);
    expect(() => module("data")).toThrow(/reserved/);
    expect(() => module("store")).toThrow(/reserved/);
    expect(() => module("call")).toThrow(/reserved/);
    expect(() => module("add")).toThrow(/reserved/);
    expect(() => module("put")).toThrow(/reserved/);
    expect(() => module("query")).toThrow(/reserved/);
    expect(() => module("constructor")).toThrow(/reserved/);
  });

  test("reservation keys on the ROOT segment only (dotted paths)", () => {
    expect(() => module("query.subroute")).toThrow(/reserved/);
    expect(() => module("constructor.x")).toThrow(/reserved/);
    // A reserved word as a non-root segment is fine — only the root collides.
    expect(() => module("authz.query")).not.toThrow();
    expect(() => module("authz.modules")).not.toThrow();
  });

  test("the thrown message names the offending reserved root", () => {
    expect(() => module("modules")).toThrow(/"modules"/);
    expect(() => module("constructor")).toThrow(/"constructor"/);
  });

  test("non-reserved roots construct fine", () => {
    expect(() => module("authz")).not.toThrow();
    expect(() => module("policies.admission.deny")).not.toThrow();
    // Inherited Object.prototype names are NOT reserved (handled structurally
    // by the proxies' own-property check, not by RESERVED).
    expect(() => module("hasOwnProperty")).not.toThrow();
    expect(() => module("valueOf")).not.toThrow();
    expect(() => module("toString")).not.toThrow();
  });

  test("a package named hasOwnProperty is reachable through the ctx proxy", () => {
    // Proves inherited Object.prototype names are routed, not shadowed.
    const helper = module("hasOwnProperty").func("ping", () => "pong");
    const caller = module("p").complete("v", (ctx) => ctx.call("hasOwnProperty.ping"));
    const e = new Engine().add(helper).add(caller);
    const d = e.query("p.v");
    expect(d.defined && d.result).toBe("pong");
  });
});
