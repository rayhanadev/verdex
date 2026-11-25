// Type-checking performance guard for large registries.
//
// Generates one file per scenario — N modules in one bundle, N modules added one at
// a time, and one module with a 3N-step builder chain. Each module has a zod input
// schema, a func, two defaulted boolean rules, a reason set and a rule reference
// (the shape of a real app policy). Each file is type-checked with tsgo, and the
// script fails when a scenario exceeds its check-time budget. The generated files also carry `@ts-expect-error` probes, so a
// registry that silently collapsed to `any` (which would type-check "fast") fails
// too.
//
// Run: bun run typecheck:perf   (N and the budget are tunable via env)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const N = Number(process.env.VERDEX_TYPE_PERF_MODULES ?? 100);
const BUDGET_S = Number(process.env.VERDEX_TYPE_PERF_BUDGET ?? 5);
const root = join(import.meta.dir, "..");
const dir = join(root, ".type-perf");

function moduleSource(i: number): string {
  return `export const m${i} = module("pkg${i}", {
  input: z.object({ actor: Actor, record: z.object({ ownerId: z.string(), status: Status }) }),
})
  .func("isOwner", (ctx) => ctx.input.record.ownerId === ctx.input.actor.userId)
  .default("read", false)
  .when("read", (ctx) => ctx.input.actor.roles.includes("super_admin"))
  .when("read", (ctx) => ctx.pkg${i}.isOwner())
  .default("edit", false)
  .when("edit", (ctx) => ctx.pkg${i}.isOwner() && ctx.input.record.status === "draft", true, { id: "owner_draft" })
  .contains("why", (ctx) => !ctx.pkg${i}.isOwner(), "not_owner" as const)
  .contains("why", (ctx) => ctx.input.record.status !== "draft", "not_draft" as const)
  .complete("summary", (ctx) => (ctx.pkg${i}.read() ? "reader" : undefined));
`;
}

const header = `import { z } from "zod";
import { Engine, bundle, module } from "../src/index.ts";

const Role = z.enum(["organizer", "super_admin", "board_member", "board_secretary", "grant_reviewer", "grants_lead"]);
const Actor = z.object({ userId: z.string().nullable(), roles: z.array(Role), records: z.enum(["own", "all"]) });
const Status = z.enum(["draft", "open", "closed"]);
`;

const ids = Array.from({ length: N }, (_, i) => i);
const last = N - 1;

// Shared probes: typed results, decide(), the proxy forms, and negative checks that
// must stay errors (input shape, unknown path, decide on a rule without default).
function probes(engine: string): string {
  return `
const input = {
  actor: { userId: "u1", roles: ["organizer" as const], records: "own" as const },
  record: { ownerId: "u1", status: "draft" as const },
};
export const read: boolean = ${engine}.decide("pkg${last}.read", { input });
export const edit = ${engine}.pkg${Math.floor(N / 2)}.edit({ input });
export const why: ("not_owner" | "not_draft")[] = ${engine}.pkg0.why.decide({ input });
export const summary = ${engine}.evaluate("pkg${last}.summary", { input });
export const handle = ${engine}.compile("pkg1.read");
// @ts-expect-error the input shape is checked
${engine}.pkg1.read({ input: { actor: 1 } });
// @ts-expect-error unknown paths are rejected
${engine}.query("pkg1.nope", { input });
// @ts-expect-error decide() needs an always-defined rule
${engine}.decide("pkg2.summary", { input });
`;
}

// One module with a long builder chain (default + when pairs and contains clauses):
// registries must not hit TypeScript's instantiation-depth limit.
const CLAUSES = 2 * N;
function longChain(): string {
  const steps: string[] = [];
  for (let i = 0; i < CLAUSES; i++) {
    steps.push(
      i % 2 === 0
        ? `  .default("r${i}", false)\n  .when("r${i}", (ctx) => ctx.input.n === ${i} && ctx.big.positive())`
        : `  .contains("s${i}", (ctx) => ctx.input.n === ${i}, "v${i}" as const)`,
    );
  }
  return `${header}
const big = module("big", { input: z.object({ n: z.number() }) })
  .func("positive", (ctx) => ctx.input.n > 0)
${steps.join("\n")};
const engine = new Engine().add(big);
export const first: boolean = engine.decide("big.r0", { input: { n: 1 } });
export const last = engine.big.r${CLAUSES - 2}({ input: { n: 1 } });
export const reasons: "v1"[] = engine.big.s1.decide({ input: { n: 1 } });
// @ts-expect-error the input shape is checked
engine.big.r0({ input: { n: "1" } });
// @ts-expect-error unknown paths are rejected
engine.query("big.nope", { input: { n: 1 } });
`;
}

const scenarios: Record<string, string> = {
  "long-chain": longChain(),
  bundle: `${header}
${ids.map(moduleSource).join("\n")}
const engine = new Engine().add(bundle({ modules: [${ids.map((i) => `m${i}`).join(", ")}] }));
${probes("engine")}`,
  "chained-add": `${header}
${ids.map(moduleSource).join("\n")}
const engine = new Engine()${ids.map((i) => `.add(m${i})`).join("")};
${probes("engine")}`,
};

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let failed = false;
for (const [name, source] of Object.entries(scenarios)) {
  writeFileSync(join(dir, `${name}.ts`), source);
  const tsconfig = {
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "esnext"],
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      isolatedModules: true,
      allowImportingTsExtensions: true,
    },
    files: [`${name}.ts`],
  };
  const project = join(dir, `tsconfig.${name}.json`);
  writeFileSync(project, JSON.stringify(tsconfig, null, 2));
  const proc = Bun.spawnSync(["bunx", "tsgo", "-p", project, "--extendedDiagnostics"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  const check = Number(/Check time:\s+([\d.]+)s/.exec(out)?.[1] ?? Number.NaN);
  const instantiations = /Instantiations:\s+(\d+)/.exec(out)?.[1] ?? "?";
  const errors = out.split("\n").filter((l) => l.includes("error TS"));
  const ok = proc.exitCode === 0 && errors.length === 0 && check <= BUDGET_S;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name.padEnd(12)} N=${N}  check ${check.toFixed(3)}s  (budget ${BUDGET_S}s)  instantiations ${instantiations}`,
  );
  if (errors.length > 0) console.log(errors.slice(0, 10).join("\n"));
  if (!ok) failed = true;
}

rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
