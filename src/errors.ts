import type { StandardSchemaV1 } from "./schema.ts";

/**
 * Base class for every error the policy engine throws on its own. Catch this to
 * branch on engine failures generically; catch a subclass to handle a specific
 * cause. Distinct from a thrown user error inside a rule body, which propagates
 * unchanged.
 */
export class PolicyError extends Error {
  override name = "PolicyError";
}

/**
 * Thrown when multiple clauses of a `complete` rule produce different values for
 * the same query — the engine refuses to pick one. Inspect {@link values} for the
 * conflicting results.
 */
export class ConflictError extends PolicyError {
  override name = "ConflictError";
  constructor(
    /** Fully-qualified path of the rule that conflicted. */
    public readonly rulePath: string,
    /** The distinct values the rule's clauses produced. */
    public readonly values: readonly unknown[],
  ) {
    super(`conflicting values for rule "${rulePath}": ${values.length} distinct results`);
  }
}

/** Thrown when a query targets a path that no module declares a rule for. */
export class UnknownRuleError extends PolicyError {
  override name = "UnknownRuleError";
  constructor(
    /** The path that was queried. */
    public readonly path: string,
  ) {
    super(`no rule found at path "${path}"`);
  }
}

/**
 * Thrown when a rule name is redeclared with an incompatible kind (e.g. a
 * `set` clause added to a name already defined as `complete`), or when a `func`
 * rule is declared more than once.
 */
export class RuleKindMismatchError extends PolicyError {
  override name = "RuleKindMismatchError";
  constructor(
    /** The rule name that was redeclared. */
    public readonly ruleName: string,
    /** The kind the rule was first declared as. */
    public readonly existing: string,
    /** The conflicting kind that was attempted. */
    public readonly incoming: string,
  ) {
    super(`rule "${ruleName}" already declared as ${existing}, cannot redeclare as ${incoming}`);
  }
}

/**
 * Thrown when a Standard Schema rejects a value (input, data, function argument,
 * or function output). Inspect {@link issues} for the schema's reported problems.
 */
export class ValidationError extends PolicyError {
  override name = "ValidationError";
  constructor(
    /** Human-readable description of what was being validated. */
    public readonly subject: string,
    /** The validation issues reported by the schema. */
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super(`${subject} failed schema validation: ${formatIssues(issues)}`);
  }
}

/**
 * Thrown when a Standard Schema validates asynchronously. The engine is fully
 * synchronous and cannot await; supply only synchronous schemas.
 */
export class AsyncSchemaError extends PolicyError {
  override name = "AsyncSchemaError";
  constructor(
    /** Human-readable description of what was being validated. */
    public readonly subject: string,
  ) {
    super(`${subject} schema is async; this engine only supports synchronous schemas`);
  }
}

/**
 * Thrown for invalid rule dispatch: querying a `func` rule directly (call it via
 * `ctx.call` instead), or calling a path that is not a function rule.
 */
export class RuleQueryError extends PolicyError {
  override name = "RuleQueryError";
}

/** Thrown when a query's `with` override targets something that cannot be overridden. */
export class OverrideError extends PolicyError {
  override name = "OverrideError";
}

/**
 * Thrown by `Engine.add()` when a module's package name is already registered on
 * the engine (whether added directly, via a bundle, or by re-adding a module).
 *
 * Each package name must be unique per engine: clauses for the same rule only
 * combine within a single {@link Module}, so two modules sharing a package name
 * would silently not merge. Split the rules into distinct package names, or
 * declare every clause of a rule in one module.
 */
export class DuplicatePackageError extends PolicyError {
  override name = "DuplicatePackageError";
  constructor(
    /** The package name that was registered more than once. */
    public readonly packageName: string,
  ) {
    super(
      `package "${packageName}" is already registered on this engine; ` +
        `each package name must be unique (declare all clauses of a rule in one module)`,
    );
  }
}

/**
 * Validate `value` against a Standard Schema synchronously and return the parsed
 * output. Used internally to enforce module input/data and function arg/output
 * schemas.
 *
 * @param schema - the Standard Schema to validate against
 * @param value - the value to validate
 * @param subject - label woven into error messages identifying what is validated
 * @returns the schema's parsed output value
 * @throws {AsyncSchemaError} if the schema validates asynchronously
 * @throws {ValidationError} if the schema reports any issues
 * @internal
 */
export function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  subject: string,
): StandardSchemaV1.InferOutput<S> {
  const r = schema["~standard"].validate(value);
  if (isThenable(r)) {
    throw new AsyncSchemaError(subject);
  }
  if (r.issues) throw new ValidationError(subject, r.issues);
  return r.value as StandardSchemaV1.InferOutput<S>;
}

function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues
    .map((i) => {
      const path =
        i.path && i.path.length > 0
          ? ` at ${i.path
              .map((s) => (typeof s === "object" ? String(s.key) : String(s)))
              .join(".")}`
          : "";
      return `${i.message}${path}`;
    })
    .join("; ");
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v != null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}
