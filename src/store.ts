import { freezeTree, sealNode } from "./snapshot.ts";
import type { Path } from "./types.ts";
import { assertSafeKey, splitPath } from "./types.ts";

type JsonObject = { [k: string]: unknown };

const hasOwn = Object.prototype.hasOwnProperty;

const EMPTY_ROOT: JsonObject = sealNode({});

/**
 * A read-only view of the data {@link Store} handed to rule bodies as `ctx.store`.
 * Exposes only safe reads — pollution-guarded path lookup and a change counter —
 * so a rule cannot mutate shared engine state mid-query. The full mutable Store
 * lives on the engine (`engine.store` / `engine.put`).
 */
export interface ReadonlyStore {
  /** Read the value at `path` (own-properties only); `undefined` if any segment is missing. */
  get(path: Path): unknown;
  /** The Store's mutation counter at query time. */
  readonly version: number;
}

/**
 * The `data` document backing an {@link Engine}: a nested JSON object addressed by
 * dotted paths, with reads and writes hardened against prototype pollution
 * (own-property reads only; unsafe keys like `__proto__` are refused on write, at
 * any depth).
 *
 * The document is persistent: every write copies the path it changes and freezes
 * the result, and written values are copied in deep-frozen. A document snapshot
 * therefore never changes, which lets every query use it without copying it, and
 * lets engines derived with `add()` share it safely. Every mutation bumps
 * {@link version}. You usually interact with it through the engine.
 */
export class Store implements ReadonlyStore {
  private root: JsonObject = EMPTY_ROOT;
  private _version = 0;
  private facade: ReadonlyStore | undefined;

  /** A store that starts from an existing frozen document. @internal */
  static from(root: unknown, version: number): Store {
    const s = new Store();
    s.root = root as JsonObject;
    s._version = version;
    return s;
  }

  /** The current root data object: a deep-frozen snapshot. Mutate via the methods below. */
  get document(): unknown {
    return this.root;
  }

  /** A counter incremented on every mutation, usable for change detection. */
  get version(): number {
    return this._version;
  }

  /** The frozen, read-only view of this store handed to rule contexts. @internal */
  asReadonly(): ReadonlyStore {
    if (this.facade) return this.facade;
    const store = this;
    this.facade = Object.freeze({
      get: (path: Path) => store.get(path),
      get version() {
        return store.version;
      },
    });
    return this.facade;
  }

  /** A new store with the same document and version; later writes to either stay separate. @internal */
  fork(): Store {
    return Store.from(this.root, this._version);
  }

  /**
   * Read the value at `path`, walking only own properties so inherited or
   * polluted members never surface.
   *
   * @param path - dotted string or segment array
   * @returns the value at the path (deep-frozen), or `undefined` if any segment is missing
   */
  get(path: Path): unknown {
    const segments = splitPath(path);
    let cur: unknown = this.root;
    for (const seg of segments) {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
        return undefined;
      }
      // Own-property reads only: never surface inherited (or polluted) members.
      if (!hasOwn.call(cur, seg)) return undefined;
      cur = (cur as JsonObject)[seg];
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  /**
   * Write `value` at `path`, creating intermediate objects as needed. An empty
   * path replaces the entire root, which must then be a plain object. The store
   * keeps a deep-frozen copy of `value` (a deep-frozen `value` is kept as-is), so
   * later changes to the caller's object do not reach the store.
   *
   * @param path - dotted string or segment array; empty path targets the root
   * @param value - the value to store
   * @throws {TypeError} if a path segment or any key inside `value` is an unsafe
   *   key, or if replacing the root with a non-object
   */
  put(path: Path, value: unknown): void {
    const segments = splitPath(path);
    if (segments.length === 0) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("root data document must be an object");
      }
      // A non-plain root (e.g. a class instance) is flattened to a plain object, as in 0.2.
      const proto = Object.getPrototypeOf(value);
      const plain = proto === Object.prototype || proto === null ? value : { ...value };
      this.root = freezeTree(plain as JsonObject, "type", "data document root", true);
      this._version++;
      return;
    }
    const where = `put path "${segments.join(".")}"`;
    for (const seg of segments) assertSafeKey(seg, where);
    const frozen = freezeTree(value, "type", `value at ${where}`, true);
    this.root = setPath(this.root, segments, 0, frozen);
    this._version++;
  }

  /**
   * Remove the entry at `path`. An empty path clears the whole document.
   *
   * @param path - dotted string or segment array; empty path clears the root
   * @returns `true` if something was removed, `false` if the path was absent
   * @throws {TypeError} if a path segment is an unsafe key
   */
  delete(path: Path): boolean {
    const segments = splitPath(path);
    if (segments.length === 0) {
      this.root = EMPTY_ROOT;
      this._version++;
      return true;
    }
    for (const seg of segments) assertSafeKey(seg, `delete path "${segments.join(".")}"`);
    const next = deletePath(this.root, segments, 0);
    if (next === undefined) return false;
    this.root = next;
    this._version++;
    return true;
  }

  /**
   * Recursively merge `obj` into the document: nested plain objects are merged
   * key by key, while arrays and primitives overwrite. The merge is atomic: a
   * rejected key leaves the document unchanged.
   *
   * @param obj - the object to deep-merge into the root
   * @throws {TypeError} if any merged key is an unsafe key
   */
  merge(obj: JsonObject): void {
    this.root = mergeInto(this.root, obj);
    this._version++;
  }
}

function isRecord(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Copy `node` with `value` written at `segments[i..]`. Intermediate values that are
// missing or not plain objects are replaced by fresh objects, as in 0.2.
function setPath(
  node: JsonObject,
  segments: readonly string[],
  i: number,
  value: unknown,
): JsonObject {
  const key = segments[i]!;
  const out: JsonObject = { ...node };
  if (i === segments.length - 1) {
    out[key] = value;
  } else {
    const next = hasOwn.call(node, key) ? node[key] : undefined;
    out[key] = setPath(isRecord(next) ? next : EMPTY_ROOT, segments, i + 1, value);
  }
  return sealNode(out);
}

// Copy `node` without the entry at `segments[i..]`, or return undefined when the
// path is absent (so the caller can report a no-op without bumping the version).
function deletePath(
  node: JsonObject,
  segments: readonly string[],
  i: number,
): JsonObject | undefined {
  const key = segments[i]!;
  if (!hasOwn.call(node, key)) return undefined;
  if (i === segments.length - 1) {
    const out: JsonObject = { ...node };
    delete out[key];
    return sealNode(out);
  }
  const next = node[key];
  if (!isRecord(next)) return undefined;
  const child = deletePath(next, segments, i + 1);
  if (child === undefined) return undefined;
  return sealNode({ ...node, [key]: child });
}

function mergeInto(target: JsonObject, source: JsonObject): JsonObject {
  const out: JsonObject = { ...target };
  for (const [k, v] of Object.entries(source)) {
    assertSafeKey(k, "merged data document");
    const existing = hasOwn.call(target, k) ? target[k] : undefined;
    out[k] =
      isRecord(existing) && isRecord(v)
        ? mergeInto(existing, v)
        : freezeTree(v, "type", "merged data document", true);
  }
  return sealNode(out);
}
