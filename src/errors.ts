import type { StandardSchemaV1 } from "./schema.ts";

export class PolicyError extends Error {
  override name = "PolicyError";
}

export class ConflictError extends PolicyError {
  override name = "ConflictError";
  constructor(
    public readonly rulePath: string,
    public readonly values: readonly unknown[],
  ) {
    super(
      `conflicting values for rule "${rulePath}": ${values
        .map((v) => safe(v))
        .join(" vs ")}`,
    );
  }
}

export class UnknownRuleError extends PolicyError {
  override name = "UnknownRuleError";
  constructor(public readonly path: string) {
    super(`no rule found at path "${path}"`);
  }
}

export class RuleKindMismatchError extends PolicyError {
  override name = "RuleKindMismatchError";
  constructor(
    public readonly ruleName: string,
    public readonly existing: string,
    public readonly incoming: string,
  ) {
    super(
      `rule "${ruleName}" already declared as ${existing}, cannot redeclare as ${incoming}`,
    );
  }
}

export class ValidationError extends PolicyError {
  override name = "ValidationError";
  constructor(
    public readonly subject: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super(`${subject} failed schema validation: ${formatIssues(issues)}`);
  }
}

export function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  subject: string,
): StandardSchemaV1.InferOutput<S> {
  const r = schema["~standard"].validate(value);
  if (r instanceof Promise) {
    throw new PolicyError(
      `${subject} schema is async; this engine only supports synchronous schemas`,
    );
  }
  if (r.issues) throw new ValidationError(subject, r.issues);
  return r.value as StandardSchemaV1.InferOutput<S>;
}

function formatIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): string {
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

function safe(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
