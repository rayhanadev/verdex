import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  Bundle,
  ConflictError,
  Engine,
  Module,
  UnknownRuleError,
  ValidationError,
  bundle,
  match,
  module,
} from "../src/index.ts";

describe("complete rules", () => {
  test("typed query returns rule value when defined", () => {
    const Input = z.object({ role: z.string() });
    const m = module("authz", { input: Input }).complete("allow", (ctx) =>
      ctx.input.role === "admin" ? true : undefined,
    );
    const e = new Engine().add(m);
    const d = e.query("authz.allow", { input: { role: "admin" } });
    expect(d.defined).toBe(true);
    if (d.defined) {
      const r: boolean = d.result; // typed without <T>
      expect(r).toBe(true);
    }
  });

  test("falls back to default when undefined", () => {
    const Input = z.object({ role: z.string() });
    const m = module("authz", { input: Input })
      .default("allow", false)
      .complete("allow", (ctx) =>
        ctx.input.role === "admin" ? true : undefined,
      );
    const e = new Engine().add(m);
    const d = e.query("authz.allow", { input: { role: "guest" } });
    if (d.defined) expect(d.result).toBe(false);
  });

  test("multiple complete rules with same value are fine", () => {
    const m = module("p")
      .complete("allow", () => true as const)
      .complete("allow", () => true as const);
    const d = new Engine().add(m).query("p.allow");
    if (d.defined) expect(d.result).toBe(true);
  });

  test("multiple complete rules with conflicting values throw", () => {
    const m = module("p")
      .complete("allow", (): boolean | undefined => true)
      .complete("allow", (): boolean | undefined => false);
    const e = new Engine().add(m);
    expect(() => e.query("p.allow")).toThrow(ConflictError);
  });

  test("default-only rule with no complete defined", () => {
    const m = module("p").default("allow", false);
    const d = new Engine().add(m).query("p.allow");
    if (d.defined) expect(d.result).toBe(false);
  });
});

describe("set rules (partial set)", () => {
  test("unions members from multiple rules", () => {
    const Input = z.object({ authed: z.boolean(), role: z.string() });
    const m = module("authz", { input: Input })
      .set("deny", function* (ctx) {
        if (!ctx.input.authed) yield "must authenticate";
      })
      .set("deny", function* (ctx) {
        if (ctx.input.role === "banned") yield "user is banned";
      });
    const d = new Engine()
      .add(m)
      .query("authz.deny", { input: { authed: false, role: "banned" } });
    if (d.defined) {
      // typed as string[], no <T> needed
      expect(d.result).toEqual(["must authenticate", "user is banned"]);
    }
  });

  test("deduplicates equal members", () => {
    const m = module("p")
      .set("s", function* () {
        yield "x";
      })
      .set("s", function* () {
        yield "x";
      });
    const d = new Engine().add(m).query("p.s");
    if (d.defined) expect(d.result).toEqual(["x"]);
  });
});

describe("object rules (partial object)", () => {
  test("collects key/value pairs from typed data", () => {
    const Data = z.object({
      apps: z.array(z.object({ host: z.string(), name: z.string() })),
    });
    const m = module("p", { data: Data }).object("apps_by_host", function* (ctx) {
      for (const a of ctx.data.apps) yield [a.host, a.name];
    });
    const e = new Engine().add(m).put("apps", [
      { host: "h1", name: "alpha" },
      { host: "h2", name: "beta" },
    ]);
    const d = e.query("p.apps_by_host");
    if (d.defined) expect(d.result).toEqual({ h1: "alpha", h2: "beta" });
  });

  test("conflicting values for same key throw", () => {
    const m = module("p")
      .object("o", function* () {
        yield ["k", 1];
      })
      .object("o", function* () {
        yield ["k", 2];
      });
    const e = new Engine().add(m);
    expect(() => e.query("p.o")).toThrow(ConflictError);
  });
});

describe("functions and typed ctx.call", () => {
  test("ctx.call is typed via the registry — args & return inferred", () => {
    const User = z.object({ role: z.string() });
    const m = module("authz")
      .func("isAdmin", { args: [User], output: z.boolean() }, (_ctx, user) =>
        user.role === "admin",
      )
      .complete("allow", (ctx) =>
        // ctx.call("authz.isAdmin", user) — user typed as {role:string}, return boolean
        ctx.call("authz.isAdmin", { role: "admin" }) ? true : undefined,
      );
    const d = new Engine().add(m).query("authz.allow");
    if (d.defined) expect(d.result).toBe(true);
  });

  test("function arg validation throws on bad input", () => {
    const User = z.object({ role: z.string() });
    const m = module("p").func(
      "needsRole",
      { args: [User], output: z.boolean() },
      () => true,
    );
    // Use the string fallback to send a bad arg through (typed call would error at compile-time).
    const m2 = module("p2").complete("v", (ctx) => {
      const r = (ctx.call as (path: string, ...args: unknown[]) => unknown)(
        "p.needsRole",
        { wrong: true },
      );
      return r as boolean;
    });
    const e = new Engine().add(m).add(m2);
    expect(() => e.query("p2.v")).toThrow(ValidationError);
  });

  test("querying a function rule directly throws", () => {
    const m = module("p").func("f", () => 1);
    expect(() => new Engine().add(m).query("p.f" as string)).toThrow();
  });
});

describe("with-overrides", () => {
  test("input override is scoped to a single query", () => {
    const Input = z.object({ user: z.string() });
    const m = module("p", { input: Input }).complete("u", (ctx) => ctx.input.user);
    const e = new Engine().add(m);
    const a = e.query("p.u", { input: { user: "alice" } });
    const b = e.query("p.u", {
      input: { user: "alice" },
      with: [{ target: "input.user", value: "bob" }],
    });
    const c = e.query("p.u", { input: { user: "alice" } });
    if (a.defined) expect(a.result).toBe("alice");
    if (b.defined) expect(b.result).toBe("bob");
    if (c.defined) expect(c.result).toBe("alice");
  });

  test("data override replaces a data sub-path", () => {
    const Data = z.object({ foo: z.object({ bar: z.number() }) });
    const m = module("p", { data: Data }).complete("v", (ctx) => ctx.data.foo.bar);
    const e = new Engine().add(m).put("foo", { bar: 1 });
    const d1 = e.query("p.v");
    if (d1.defined) expect(d1.result).toBe(1);
    const d2 = e.query("p.v", {
      with: [{ target: "data.foo.bar", value: 99 }],
    });
    if (d2.defined) expect(d2.result).toBe(99);
    const d3 = e.query("p.v");
    if (d3.defined) expect(d3.result).toBe(1);
  });
});

describe("schema validation", () => {
  test("input validation rejects bad input", () => {
    const Input = z.object({ role: z.enum(["admin", "guest"]) });
    const m = module("authz", { input: Input }).complete("allow", () => true);
    const e = new Engine().add(m);
    expect(() =>
      e.query("authz.allow", { input: { role: "bogus" } }),
    ).toThrow(ValidationError);
  });

  test("data validation rejects bad data", () => {
    const Data = z.object({ count: z.number() });
    const m = module("p", { data: Data }).complete("v", (ctx) => ctx.data.count);
    const e = new Engine().add(m).put("count", "not a number");
    expect(() => e.query("p.v")).toThrow(ValidationError);
  });

  test("function output validation catches bugs", () => {
    const m = module("p").func(
      "broken",
      { args: [], output: z.boolean() },
      () => "oops" as unknown as boolean,
    );
    const m2 = module("p2").complete("v", (ctx) => ctx.call("p.broken"));
    const e = new Engine().add(m).add(m2);
    expect(() => e.query("p2.v")).toThrow(ValidationError);
  });
});

describe("bundles", () => {
  test("bundle() infers registry from its modules", () => {
    const Data = z.object({ name: z.string() });
    const m = module("p", { data: Data }).complete(
      "greet",
      (ctx) => `hello ${ctx.data.name}`,
    );
    const b = bundle({ modules: [m], data: { name: "world" } });
    const d = new Engine().add(b).query("p.greet");
    if (d.defined) expect(d.result).toBe("hello world");
  });

  test("plain Bundle still works (untyped)", () => {
    const m = module("p").complete("v", () => 42);
    const b = new Bundle({ modules: [m] });
    const d = new Engine().add(b).query<number>("p.v");
    if (d.defined) expect(d.result).toBe(42);
  });
});

describe("undefined paths", () => {
  test("query for unknown rule path throws (string fallback)", () => {
    expect(() => new Engine().query("nope.allow")).toThrow(UnknownRuleError);
  });

  test("rule that returns undefined with no default is not defined", () => {
    const m = module("p").complete("v", () => undefined);
    const d = new Engine().add(m).query("p.v");
    expect(d.defined).toBe(false);
    expect(d.result).toBeUndefined();
  });
});

describe("match() helper", () => {
  test("first-match-wins with otherwise default", () => {
    const result = match({ role: "guest", banned: false })
      .when((x) => x.banned, "banned")
      .when((x) => x.role === "admin", "admin")
      .when((x) => x.role === "guest", "guest")
      .otherwise("other");
    expect(result).toBe("guest");
  });

  test("returns otherwise when nothing matches", () => {
    const r = match(0)
      .when((n) => n > 10, "big")
      .when((n) => n < -10, "tiny")
      .otherwise("middle");
    expect(r).toBe("middle");
  });

  test("supports value resolvers (functions)", () => {
    const r = match("hi")
      .when((s) => s === "hi", (s) => s.toUpperCase())
      .otherwise("");
    expect(r).toBe("HI");
  });
});

describe("when() and contains() clause sugar", () => {
  test("m.when registers additive complete clauses", () => {
    const Input = z.object({ role: z.string(), action: z.string() });
    const m = module("authz", { input: Input })
      .default("allow", false)
      .when("allow", (ctx) => ctx.input.role === "admin")
      .when("allow", (ctx) =>
        ctx.input.role === "member" && ctx.input.action !== "delete",
      )
      .when("allow", (ctx) =>
        ctx.input.role === "guest" && ctx.input.action === "read",
      );
    const e = new Engine().add(m);

    const a = e.query("authz.allow", { input: { role: "admin", action: "delete" } });
    const b = e.query("authz.allow", { input: { role: "member", action: "write" } });
    const c = e.query("authz.allow", { input: { role: "guest", action: "read" } });
    const d = e.query("authz.allow", { input: { role: "guest", action: "write" } });
    if (a.defined) expect(a.result).toBe(true);
    if (b.defined) expect(b.result).toBe(true);
    if (c.defined) expect(c.result).toBe(true);
    if (d.defined) expect(d.result).toBe(false); // default
  });

  test("m.when accepts an explicit value for non-boolean rules", () => {
    const Input = z.object({ urgent: z.boolean(), high: z.boolean() });
    const m = module("p", { input: Input })
      .default("priority", 0)
      .when("priority", (ctx) => ctx.input.urgent, 10)
      .when("priority", (ctx) => ctx.input.high, 5);
    const e = new Engine().add(m);
    const a = e.query("p.priority", { input: { urgent: true, high: false } });
    if (a.defined) expect(a.result).toBe(10);
    const b = e.query("p.priority", { input: { urgent: false, high: true } });
    if (b.defined) expect(b.result).toBe(5);
    const c = e.query("p.priority", { input: { urgent: false, high: false } });
    if (c.defined) expect(c.result).toBe(0);
  });

  test("m.contains yields values into a partial set", () => {
    const Input = z.object({ banned: z.boolean(), guest: z.boolean() });
    const m = module("authz", { input: Input })
      .contains(
        "deny_reasons",
        (ctx) => ctx.input.banned,
        "user is banned",
      )
      .contains(
        "deny_reasons",
        (ctx) => ctx.input.guest,
        "guests can only read",
      );
    const e = new Engine().add(m);
    const d = e.query("authz.deny_reasons", {
      input: { banned: true, guest: true },
    });
    if (d.defined)
      expect(d.result).toEqual(["user is banned", "guests can only read"]);
  });
});

describe("type-level checks (compile-only)", () => {
  test("typo paths produce ts errors via @ts-expect-error", () => {
    const m = module("authz").complete("allow", () => true);
    const e = new Engine().add(m);
    // Compile-time-only assertion: this line errors under TS strict mode.
    if (false as boolean) {
      // @ts-expect-error — "authz.allwo" is not a known path
      e.query("authz.allwo");
    }
    // Runtime sanity: an unknown path passed through the escape hatch still throws.
    expect(() =>
      (e.query as (p: string) => unknown)("authz.allwo"),
    ).toThrow(UnknownRuleError);
  });

  test("ctx.call wrong arg type errors at compile time", () => {
    const User = z.object({ role: z.string() });
    const m = module("authz")
      .func("isAdmin", { args: [User], output: z.boolean() }, (_ctx, u) =>
        u.role === "admin",
      )
      .complete("allow", (ctx) => {
        if (false as boolean) {
          // @ts-expect-error — number not assignable to {role:string}
          ctx.call("authz.isAdmin", 42);
        }
        return ctx.call("authz.isAdmin", { role: "admin" });
      });
    const e = new Engine().add(m);
    const d = e.query("authz.allow");
    expect(d.defined).toBe(true);
  });
});

describe("proxy access (ctx.<pkg>.<rule>, engine.<pkg>.<rule>)", () => {
  test("ctx.<pkg>.<func>(...) calls the function with typed args", () => {
    const User = z.object({ role: z.string() });
    const m = module("authz")
      .func("isAdmin", { args: [User], output: z.boolean() }, (_ctx, u) =>
        u.role === "admin",
      )
      .complete("allow", (ctx) =>
        ctx.authz.isAdmin({ role: "admin" }) ? true : undefined,
      );
    const d = new Engine().add(m).query("authz.allow");
    if (d.defined) expect(d.result).toBe(true);
  });

  test("engine.<pkg>.<rule>({ input }) returns Decision<R[path]>", () => {
    const Input = z.object({ role: z.string() });
    const m = module("authz", { input: Input }).complete("allow", (ctx) =>
      ctx.input.role === "admin" ? true : undefined,
    );
    const e = new Engine().add(m);
    const d = e.authz.allow({ input: { role: "admin" } });
    if (d.defined) {
      const r: boolean = d.result;
      expect(r).toBe(true);
    }
  });

  test("nested package paths (a.b.c) walk the proxy correctly", () => {
    const m = module("policies.admission").complete("deny", () => "blocked");
    const e = new Engine().add(m);
    const d = e.policies.admission.deny();
    if (d.defined) expect(d.result).toBe("blocked");
  });

  test("proxy and string forms coexist", () => {
    const m = module("authz").complete("allow", () => 42);
    const e = new Engine().add(m);
    const a = e.authz.allow();
    const b = e.query("authz.allow");
    expect(a).toEqual(b);
  });

  test("module() throws on reserved root segments", () => {
    expect(() => module("input")).toThrow(/reserved/);
    expect(() => module("data")).toThrow(/reserved/);
    expect(() => module("query")).toThrow(/reserved/);
    expect(() => module("query.subroute")).toThrow(/reserved/);
  });

  test("@ts-expect-error: typo in proxy path errors at compile time", () => {
    const m = module("authz").complete("allow", () => true);
    const e = new Engine().add(m);
    if (false as boolean) {
      // @ts-expect-error — `allwo` is not a known rule on `authz`
      e.authz.allwo();
    }
    expect(e.authz.allow().defined).toBe(true);
  });

  test("@ts-expect-error: ctx proxy wrong arg type errors at compile time", () => {
    const User = z.object({ role: z.string() });
    const m = module("authz")
      .func("isAdmin", { args: [User], output: z.boolean() }, (_ctx, u) =>
        u.role === "admin",
      )
      .complete("allow", (ctx) => {
        if (false as boolean) {
          // @ts-expect-error — number not assignable to {role:string}
          ctx.authz.isAdmin(42);
        }
        return ctx.authz.isAdmin({ role: "admin" });
      });
    const d = new Engine().add(m).query("authz.allow");
    if (d.defined) expect(d.result).toBe(true);
  });
});

describe("Decision discriminated union", () => {
  test("type narrows after defined check", () => {
    const m = module("p").complete("v", () => 42);
    const d = new Engine().add(m).query("p.v");
    if (d.defined) {
      const n: number = d.result;
      expect(n).toBe(42);
    }
  });
});
