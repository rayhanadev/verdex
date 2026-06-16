import type { Path } from "./types.ts";
import { splitPath } from "./types.ts";

type JsonObject = { [k: string]: unknown };

export class Store {
  private root: JsonObject = {};
  private _version = 0;

  get document(): unknown {
    return this.root;
  }

  get version(): number {
    return this._version;
  }

  get(path: Path): unknown {
    const segments = splitPath(path);
    let cur: unknown = this.root;
    for (const seg of segments) {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
        return undefined;
      }
      cur = (cur as JsonObject)[seg];
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  put(path: Path, value: unknown): void {
    const segments = splitPath(path);
    if (segments.length === 0) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("root data document must be an object");
      }
      this.root = { ...(value as JsonObject) };
      this._version++;
      return;
    }
    let cur: JsonObject = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const next = cur[seg];
      if (
        next === undefined ||
        next === null ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
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

  delete(path: Path): boolean {
    const segments = splitPath(path);
    if (segments.length === 0) {
      this.root = {};
      this._version++;
      return true;
    }
    let cur: JsonObject = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const next = cur[seg];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        return false;
      }
      cur = next as JsonObject;
    }
    const last = segments[segments.length - 1]!;
    if (last in cur) {
      delete cur[last];
      this._version++;
      return true;
    }
    return false;
  }

  merge(obj: JsonObject): void {
    deepMerge(this.root, obj);
    this._version++;
  }
}

function deepMerge(target: JsonObject, source: JsonObject): void {
  for (const [k, v] of Object.entries(source)) {
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
