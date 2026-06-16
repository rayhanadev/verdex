import { z } from "zod";
import { Engine, bundle, match, module } from "../src/index.ts";

const Role = z.enum(["admin", "member", "guest"]);
const Action = z.enum(["read", "write", "delete"]);

const User = z.object({
  id: z.string(),
  role: Role,
  banned: z.boolean().optional(),
});

const Input = z.object({
  user: User,
  action: z.object({ type: Action, resource: z.string() }),
});

const Data = z.object({ users: z.array(User) });

const authz = module("authz", { input: Input, data: Data })
  .default("allow", false)
  .func("isAdmin", { args: [User], output: z.boolean() }, (_ctx, user) =>
    user.role === "admin",
  )
  .complete("allow", (ctx) =>
    match(ctx.input)
      .when((i) => i.user.banned === true, undefined)
      // Proxy form: ctx.authz.isAdmin(user) instead of ctx.call("authz.isAdmin", user)
      .when((i) => ctx.authz.isAdmin(i.user), true)
      .when(
        (i) => i.user.role === "member" && i.action.type !== "delete",
        true,
      )
      .when(
        (i) => i.user.role === "guest" && i.action.type === "read",
        true,
      )
      .otherwise(undefined),
  )
  .contains(
    "deny_reasons",
    (ctx) => ctx.input.user.banned === true,
    "user is banned",
  )
  .contains(
    "deny_reasons",
    (ctx) =>
      ctx.input.user.role === "guest" && ctx.input.action.type !== "read",
    "guests can only read",
  )
  .contains(
    "deny_reasons",
    (ctx) =>
      ctx.input.user.role === "member" && ctx.input.action.type === "delete",
    "members cannot delete",
  )
  .object("user_index", function* (ctx) {
    for (const u of ctx.data.users) yield [u.id, u];
  });

const b = bundle({
  modules: [authz],
  data: {
    users: [
      { id: "u1", role: "admin" },
      { id: "u2", role: "member" },
      { id: "u3", role: "guest" },
      { id: "u4", role: "member", banned: true },
    ],
  },
});

const engine = new Engine().add(b);

type AuthInput = z.infer<typeof Input>;

const cases: Array<{ label: string; input: AuthInput }> = [
  { label: "admin deletes a doc", input: { user: { id: "u1", role: "admin" }, action: { type: "delete", resource: "doc/1" } } },
  { label: "member writes", input: { user: { id: "u2", role: "member" }, action: { type: "write", resource: "doc/1" } } },
  { label: "member tries to delete", input: { user: { id: "u2", role: "member" }, action: { type: "delete", resource: "doc/1" } } },
  { label: "guest reads", input: { user: { id: "u3", role: "guest" }, action: { type: "read", resource: "doc/1" } } },
  { label: "guest tries to write", input: { user: { id: "u3", role: "guest" }, action: { type: "write", resource: "doc/1" } } },
  { label: "banned member writes", input: { user: { id: "u4", role: "member", banned: true }, action: { type: "write", resource: "doc/1" } } },
];

for (const c of cases) {
  // Proxy form: engine.authz.allow({ input }) instead of engine.query("authz.allow", ...)
  const allow = engine.authz.allow({ input: c.input });
  const deny = engine.authz.deny_reasons({ input: c.input });
  const allowStr = allow.defined ? String(allow.result) : "undef";
  const denyStr = deny.defined ? JSON.stringify(deny.result) : "[]";
  console.log(`${c.label.padEnd(28)} allow=${allowStr.padEnd(5)} reasons=${denyStr}`);
}

// String form still works for whoever prefers it.
const userIndex = engine.query("authz.user_index", {
  input: { user: { id: "u1", role: "admin" }, action: { type: "read", resource: "_" } },
});
console.log(
  "\nuser_index:",
  JSON.stringify(userIndex.defined ? userIndex.result : null, null, 2),
);

const overridden = engine.authz.allow({
  input: { user: { id: "u3", role: "guest" }, action: { type: "write", resource: "doc/1" } },
  with: [{ target: "input.user.role", value: "admin" }],
});
console.log(
  "\nwith-override (guest -> admin):",
  overridden.defined ? overridden.result : "undefined",
);
