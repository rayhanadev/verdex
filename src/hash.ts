// Synchronous, dependency-free hashing for policy fingerprints. Runs unchanged in
// browsers, Node, Bun, Deno and edge runtimes (no `crypto`, no BigInt).

/**
 * cyrb53: a fast 53-bit string hash with good distribution. Not cryptographic —
 * fingerprints identify policy versions; they do not authenticate them.
 */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A 106-bit hex digest of `text` (two cyrb53 lanes with different seeds).
 * @internal
 */
export function digest(text: string): string {
  const a = cyrb53(text, 0x9e3779b9).toString(16).padStart(14, "0");
  const b = cyrb53(text, 0x85ebca6b).toString(16).padStart(14, "0");
  return a + b;
}

/**
 * A deterministic text form of a value for hashing: object keys are sorted, and
 * non-JSON values (`undefined`, `NaN`, `-0`, `bigint`, `Date`, `RegExp`, `Map`,
 * `Set`, functions) get tagged forms. Cycles are cut with a marker.
 * @internal
 */
export function stableText(value: unknown, seen: Set<object> = new Set()): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "boolean":
      return String(value);
    case "undefined":
      return "undefined";
    case "bigint":
      return `${String(value)}n`;
    case "symbol":
      return `Symbol(${value.description ?? ""})`;
    case "function":
      return `fn:${Function.prototype.toString.call(value)}`;
  }
  if (value === null) return "null";
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    out = `[${obj.map((v) => stableText(v, seen)).join(",")}]`;
  } else if (obj instanceof Date) {
    out = `Date(${obj.getTime()})`;
  } else if (obj instanceof RegExp) {
    out = `RegExp(${String(obj)})`;
  } else if (obj instanceof Map) {
    out = `Map(${[...obj].map(([k, v]) => `${stableText(k, seen)}=>${stableText(v, seen)}`).join(",")})`;
  } else if (obj instanceof Set) {
    out = `Set(${[...obj].map((v) => stableText(v, seen)).join(",")})`;
  } else {
    const rec = obj as Record<string, unknown>;
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array; toSorted is missing in older browsers
    const keys = Object.keys(rec).sort();
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableText(rec[k], seen)}`).join(",")}}`;
  }
  seen.delete(obj);
  return out;
}
