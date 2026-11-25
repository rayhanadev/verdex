import { UnknownRuleError } from "./errors.ts";
import { digest, stableText } from "./hash.ts";
import type { Module } from "./module.ts";
import { FuncRule, type Rule, type RuleKind } from "./rule.ts";
import type { ModuleInfo, PolicyRef, RuleInfo } from "./types.ts";

/** @internal */
export type AnyModule = Module<any, any, any, any, any, any>;

/**
 * A rule path resolved against an engine's modules, with everything evaluation
 * needs precomputed.
 * @internal
 */
export interface Resolved {
  readonly path: string;
  readonly module: AnyModule;
  readonly name: string;
  /** The rule's kind; a default-only rule is `complete`. */
  readonly kind: RuleKind;
  readonly rules: readonly Rule[];
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
}

const moduleFingerprints = new WeakMap<AnyModule, string>();

/**
 * A stable hash of a module's policy: package, version, schema vendors, rule
 * names and kinds, defaults, clause ids, clause bodies (function source) and
 * constant clause values. Documentation metadata is excluded. Computed once per
 * (immutable) module.
 * @internal
 */
function moduleFingerprint(m: AnyModule): string {
  const cached = moduleFingerprints.get(m);
  if (cached !== undefined) return cached;
  const parts: string[] = [
    `module ${JSON.stringify(m.package.name)}`,
    `version ${stableText(m.version)}`,
    `input ${m.inputSchema?.["~standard"].vendor ?? "-"}`,
    `data ${m.dataSchema?.["~standard"].vendor ?? "-"}`,
  ];
  for (const name of m.allRuleNames()) {
    const rules = m.getRules(name) ?? [];
    parts.push(`rule ${JSON.stringify(name)} ${rules[0]?.kind ?? "complete"}`);
    if (m.hasDefault(name)) parts.push(`default ${stableText(m.getDefault(name))}`);
    for (const r of rules) {
      const body = r.info.body ?? (r as Rule & { fn: Function }).fn;
      let line = `clause ${r.id === undefined ? "-" : JSON.stringify(r.id)} ${stableText(body)}`;
      if (r.info.hasValue) line += ` value ${stableText(r.info.value)}`;
      if (r instanceof FuncRule && r.schemas) {
        const args = r.schemas.args?.map((s) => s["~standard"].vendor).join(",") ?? "-";
        line += ` schemas ${args} -> ${r.schemas.output?.["~standard"].vendor ?? "-"}`;
      }
      parts.push(line);
    }
  }
  const print = digest(parts.join("\n"));
  moduleFingerprints.set(m, print);
  return print;
}

/** The audit reference for one module. @internal */
export function policyRef(m: AnyModule): PolicyRef {
  const fingerprint = moduleFingerprint(m);
  return m.version === undefined
    ? { package: m.package.name, fingerprint }
    : { package: m.package.name, version: m.version, fingerprint };
}

/**
 * The immutable set of modules behind an engine, with a lazily built path index.
 * Engines derived with `withData()` share one Policy; `add()` builds a new one.
 * @internal
 */
export class Policy {
  readonly modules: readonly AnyModule[];
  private index: Map<string, Resolved> | undefined;
  private prefixes: Set<string> | undefined;
  private print: string | undefined;
  private infos: readonly RuleInfo[] | undefined;

  /**
   * @param modules - a fresh array the policy takes ownership of. It is typed
   *   readonly rather than frozen: Object.freeze on arrays is slow in some engines
   *   (JavaScriptCore) and engine construction is on the per-request path.
   */
  constructor(modules: AnyModule[]) {
    this.modules = modules;
  }

  /** The resolved rule at `path`, or `undefined`. */
  lookup(path: string): Resolved | undefined {
    return (this.index ?? this.build()).get(path);
  }

  /**
   * The resolved rule at `path`.
   *
   * @throws {UnknownRuleError} if no module declares a rule or default at `path`
   */
  resolve(path: string): Resolved {
    const r = (this.index ?? this.build()).get(path);
    if (r === undefined) throw new UnknownRuleError(path);
    return r;
  }

  /** Whether `path` is a rule path or a package prefix of this policy. */
  isKnown(path: string): boolean {
    if (!this.prefixes) this.build();
    return this.prefixes!.has(path) || this.index!.has(path);
  }

  /** A stable hash of every module's fingerprint, independent of add order. */
  fingerprint(): string {
    if (this.print === undefined) {
      const prints = this.modules.map((m) => `${m.package.name}=${moduleFingerprint(m)}`);
      // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array; toSorted is missing in older browsers
      this.print = digest(prints.sort().join("\n"));
    }
    return this.print;
  }

  /** Introspection records for every rule, in module-add then declaration order. */
  rules(): readonly RuleInfo[] {
    if (this.infos) return this.infos;
    const out: RuleInfo[] = [];
    for (const m of this.modules) {
      const mod: ModuleInfo = Object.freeze({
        package: m.package.name,
        ...(m.version === undefined ? {} : { version: m.version }),
        ...(m.description === undefined ? {} : { description: m.description }),
        see: m.see,
        meta: m.meta,
        fingerprint: moduleFingerprint(m),
      });
      for (const name of m.allRuleNames()) {
        const rules = m.getRules(name) ?? [];
        const meta = m.getMeta(name);
        const ids: string[] = [];
        for (const r of rules) if (r.id !== undefined) ids.push(r.id);
        const see = meta?.see;
        out.push(
          Object.freeze({
            path: joinPath(m.package.name, name),
            package: m.package.name,
            name,
            kind: rules[0]?.kind ?? "complete",
            hasDefault: m.hasDefault(name),
            clauses: rules.length,
            ids: Object.freeze(ids),
            ...(meta?.description === undefined ? {} : { description: meta.description }),
            see: Object.freeze(see === undefined ? [] : typeof see === "string" ? [see] : [...see]),
            meta: Object.freeze({ ...meta?.meta }),
            module: mod,
          }),
        );
      }
    }
    this.infos = Object.freeze(out);
    return this.infos;
  }

  private build(): Map<string, Resolved> {
    const index = new Map<string, Resolved>();
    const prefixes = new Set<string>();
    for (const m of this.modules) {
      const segs = m.package.segments;
      for (let i = 1; i <= segs.length; i++) prefixes.add(segs.slice(0, i).join("."));
      for (const name of m.allRuleNames()) {
        // A dotted rule name is unreachable by path (the last segment is always the
        // rule name), exactly as in 0.2.
        if (name.includes(".")) continue;
        const rules = m.getRules(name) ?? [];
        const path = joinPath(m.package.name, name);
        index.set(path, {
          path,
          module: m,
          name,
          kind: rules[0]?.kind ?? "complete",
          rules,
          hasDefault: m.hasDefault(name),
          defaultValue: m.getDefault(name),
        });
      }
    }
    this.prefixes = prefixes;
    this.index = index;
    return index;
  }
}

function joinPath(pkg: string, name: string): string {
  return pkg.length === 0 ? name : `${pkg}.${name}`;
}
