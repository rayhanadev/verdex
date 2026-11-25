import { UnsafeKeyError } from "./errors.ts";
import { assertSafeKey, UNSAFE_KEYS } from "./types.ts";

/**
 * What a snapshot does when it meets an own `__proto__` / `prototype` /
 * `constructor` key: throw `UnsafeKeyError` (query documents), throw `TypeError`
 * (store writes, matching the 0.2 write guards), or drop the key.
 * @internal
 */
type OnUnsafe = "reject" | "type" | "drop";

// Objects that verdex has verified (or built) to be deep-frozen plain trees with
// no unsafe keys. A frozen object can never change, so membership stays valid for
// the object's lifetime and lets every later snapshot reuse it without copying.
const vetted = new WeakSet<object>();

const objectProto = Object.prototype;

function isPlain(o: object): boolean {
  const proto = Object.getPrototypeOf(o);
  return proto === objectProto || proto === null;
}

/**
 * Return a deep-frozen view of `value` with no unsafe keys, copying only what it
 * must. Primitives and already-vetted trees return as-is. A caller-frozen tree is
 * verified once (then reused by reference); anything else is copied, so verdex
 * never freezes or mutates a caller's plain objects or arrays. Non-plain objects
 * (Date, Map, class instances) pass through by reference and are frozen in place,
 * as in 0.2.
 *
 * @param value - the document to snapshot
 * @param onUnsafe - what to do with an unsafe key
 * @param subject - label for error messages (e.g. `"input"`)
 * @param keep - remember freshly copied nodes as vetted (for long-lived documents)
 * @internal
 */
export function freezeTree<T>(value: T, onUnsafe: OnUnsafe, subject: string, keep: boolean): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value) && verify(value)) return value;
  return copy(value, onUnsafe, subject, keep) as T;
}

// Verify a frozen tree in place. Succeeds only when every nested plain object and
// array is frozen and no plain object has an unsafe key; marks each verified node.
function verify(o: object): boolean {
  if (vetted.has(o)) return true;
  if (!Object.isFrozen(o)) return false;
  if (Array.isArray(o)) {
    for (const v of o as unknown[]) {
      if (v !== null && typeof v === "object" && !verify(v)) return false;
    }
  } else if (isPlain(o)) {
    for (const k of Object.keys(o)) {
      if (UNSAFE_KEYS.has(k)) return false;
      const v = (o as Record<string, unknown>)[k];
      if (v !== null && typeof v === "object" && !verify(v)) return false;
    }
  }
  // Non-plain objects: being frozen is as far as verdex goes (see freezeTree).
  vetted.add(o);
  return true;
}

function copy(o: object, onUnsafe: OnUnsafe, subject: string, keep: boolean): object {
  if (Object.isFrozen(o) && vetted.has(o)) return o;
  if (Array.isArray(o)) {
    const out = (o as unknown[]).slice();
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      if (v !== null && typeof v === "object") out[i] = copy(v, onUnsafe, subject, keep);
    }
    Object.freeze(out);
    if (keep) vetted.add(out);
    return out;
  }
  if (!isPlain(o)) return freezeInPlace(o);
  const src = o as Record<string, unknown>;
  // Keys are checked before assignment, so `out[k] = …` never reaches the
  // `__proto__` setter: the copy keeps Object.prototype and no own unsafe key.
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (UNSAFE_KEYS.has(k)) {
      if (onUnsafe === "drop") continue;
      if (onUnsafe === "type") assertSafeKey(k, subject);
      throw new UnsafeKeyError(k, subject);
    }
    const v = src[k];
    out[k] = v !== null && typeof v === "object" ? copy(v, onUnsafe, subject, keep) : v;
  }
  Object.freeze(out);
  if (keep) vetted.add(out);
  return out;
}

// The 0.2 freeze for values that are passed through by reference: freeze, then
// recurse into own keys. Skips frozen subtrees (which also stops at cycles).
// LIMITATION: Object.freeze does not lock a Map/Set's entries or a Date's time.
function freezeInPlace<T extends object>(o: T): T {
  if (Object.isFrozen(o)) return o;
  Object.freeze(o);
  if (Array.isArray(o)) {
    for (const v of o as unknown[]) if (v !== null && typeof v === "object") freezeInPlace(v);
  } else {
    for (const k of Object.keys(o)) {
      const v = (o as Record<string, unknown>)[k];
      if (v !== null && typeof v === "object") freezeInPlace(v);
    }
  }
  return o;
}

/**
 * Mark a node that verdex itself built from vetted parts (a store path copy) as
 * vetted, after freezing it.
 * @internal
 */
export function sealNode<T extends object>(o: T): T {
  Object.freeze(o);
  vetted.add(o);
  return o;
}

/** Whether `value` is a tree verdex already vetted (deep-frozen, no unsafe keys). @internal */
export function isVetted(value: unknown): boolean {
  return value !== null && typeof value === "object" && vetted.has(value);
}

/**
 * Return a deep-frozen copy of `value` that verdex can use without copying it
 * again. Pass the result as `input` or `data` to many queries (for example the
 * facts for every decision on one page) and each query skips its snapshot step.
 * A value that is already deep-frozen is verified once and returned as-is.
 *
 * @param value - a JSON-shaped value (plain objects, arrays, primitives)
 * @returns the frozen value (the same reference when `value` was already deep-frozen)
 * @throws {UnsafeKeyError} if any plain object in `value` has an own `__proto__`,
 *   `prototype` or `constructor` key
 *
 * @example
 * ```ts
 * const facts = snapshot({ viewer, roles });
 * engine.nav.sidebar({ input: facts });
 * engine.nav.tabs({ input: facts }); // no per-query copy
 * ```
 */
export function snapshot<T>(value: T): T {
  return freezeTree(value, "reject", "snapshot", true);
}
