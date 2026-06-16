import type { Path } from "./types.ts";
import { assertSafeKey, splitPath } from "./types.ts";

type JsonObject = { [k: string]: unknown };

const hasOwn = Object.prototype.hasOwnProperty;

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
 * The mutable `data` document backing an {@link Engine}. A plain nested JSON object
 * addressed by dotted paths, with reads and writes hardened against prototype
 * pollution (own-property reads only; unsafe keys like `__proto__` are refused on
 * write). Every mutation bumps {@link version}. You usually interact with it through
 * the engine rather than directly.
 */
export class Store implements ReadonlyStore {
  private root: JsonObject = {};
  private _version = 0;

  /** The current root data object. Treat as read-only; mutate via the methods below. */
  get document(): unknown {
    return this.root;
  }

  /** A counter incremented on every mutation, usable for change detection. */
  get version(): number {
    return this._version;
  }

  /** Build a frozen, read-only view of this store for handing to rule contexts. @internal */
  asReadonly(): ReadonlyStore {
    const store = this;
    return Object.freeze({
      get: (path: Path) => store.get(path),
      get version() {
        return store.version;
      },
    });
  }

  /**
   * Read the value at `path`, walking only own properties so inherited or
   * polluted members never surface.
   *
   * @param path - dotted string or segment array
   * @returns the value at the path, or `undefined` if any segment is missing
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
   * path replaces the entire root, which must then be a plain object.
   *
   * @param path - dotted string or segment array; empty path targets the root
   * @param value - the value to store
   * @throws {TypeError} if a path segment is an unsafe key, or if replacing the
   *   root with a non-object
   */
  put(path: Path, value: unknown): void {
    const segments = splitPath(path);
    if (segments.length === 0) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("root data document must be an object");
      }
      for (const k of Object.keys(value as JsonObject)) {
        assertSafeKey(k, "data document root");
      }
      this.root = { ...(value as JsonObject) };
      this._version++;
      return;
    }
    for (const seg of segments) assertSafeKey(seg, `put path "${segments.join(".")}"`);
    let cur: JsonObject = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const next = cur[seg];
      if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
        const fresh: JsonObject = {};
        cur[seg] = fresh;
        cur = fresh;
      } else {
        cur = next as JsonObject;
      }
    }
    cur[segments[segments.length - 1]!] = value;
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
      this.root = {};
      this._version++;
      return true;
    }
    for (const seg of segments) assertSafeKey(seg, `delete path "${segments.join(".")}"`);
    let cur: JsonObject = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (!hasOwn.call(cur, seg)) return false;
      const next = cur[seg];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        return false;
      }
      cur = next as JsonObject;
    }
    const last = segments[segments.length - 1]!;
    if (hasOwn.call(cur, last)) {
      delete cur[last];
      this._version++;
      return true;
    }
    return false;
  }

  /**
   * Recursively merge `obj` into the document: nested plain objects are merged
   * key by key, while arrays and primitives overwrite.
   *
   * @param obj - the object to deep-merge into the root
   * @throws {TypeError} if any merged key is an unsafe key
   */
  merge(obj: JsonObject): void {
    deepMerge(this.root, obj);
    this._version++;
  }
}

function deepMerge(target: JsonObject, source: JsonObject): void {
  for (const [k, v] of Object.entries(source)) {
    assertSafeKey(k, "merged data document");
    const existing = target[k];
    if (
      existing !== undefined &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      deepMerge(existing as JsonObject, v as JsonObject);
    } else {
      target[k] = v;
    }
  }
}
