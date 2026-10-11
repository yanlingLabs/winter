// ComputerV2 Phase 3 — the REDUCTION every transport applies to an event before it leaves the browser's process: the
// pinned `cdp-allowlist.ts` says WHAT may cross (CDP_EVENT_PARAMS: dotted paths, `[]` for every element of an array);
// this applies it. Pure and dependency-free: the Winter for Chrome extension bundles it (its guard), the daemon's own
// transports use it, and Winter.app's link has a Swift twin (WinterKit `CDPEventReducer`) held to it by the shared
// cases in `packages/core/test/computer-use/fixtures/cdp-reduce-cases.json`.
//
// The rules: an event with no entry leaves whole. Otherwise only the listed paths survive; a LEAF keeps a string (cut at
// CDP_EVENT_STRING_MAX), a number, a boolean or null — never an object or an array, so no structure leaves by accident;
// an array keeps at most CDP_EVENT_ARRAY_MAX elements; an object left empty is dropped. `Fetch.requestPaused`'s
// `responseHeaders` lose every entry whose name is not in CDP_FETCH_RESPONSE_HEADERS BEFORE the paths are picked.
import { CDP_EVENT_ARRAY_MAX, CDP_EVENT_PARAMS, CDP_EVENT_STRING_MAX, CDP_FETCH_RESPONSE_HEADERS } from "./cdp-allowlist";

interface Node { leaf: boolean; array: boolean; children: Map<string, Node> }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function trieOf(paths: readonly string[]): Map<string, Node> {
  const root = new Map<string, Node>();
  for (const path of paths) {
    let level = root;
    const segs = path.split(".");
    segs.forEach((raw, i) => {
      const array = raw.endsWith("[]");
      const key = array ? raw.slice(0, -2) : raw;
      let node = level.get(key);
      if (node === undefined) { node = { leaf: false, array, children: new Map() }; level.set(key, node); }
      if (i === segs.length - 1) node.leaf = true;
      level = node.children;
    });
  }
  return root;
}

const TRIES = new Map<string, Map<string, Node>>(Object.entries(CDP_EVENT_PARAMS).map(([m, paths]) => [m, trieOf(paths)]));
const FETCH_HEADERS = new Set(CDP_FETCH_RESPONSE_HEADERS);

function leafValue(v: unknown): unknown {
  if (typeof v === "string") return v.length > CDP_EVENT_STRING_MAX ? v.slice(0, CDP_EVENT_STRING_MAX) : v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  return undefined;
}

function element(v: unknown, node: Node): unknown {
  if (node.children.size > 0) {
    if (!isRecord(v)) return undefined;
    const r = pick(v, node.children);
    return Object.keys(r).length > 0 ? r : undefined;
  }
  return leafValue(v);
}

function pick(obj: Record<string, unknown>, level: Map<string, Node>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of level) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = obj[key];
    if (node.array) {
      if (!Array.isArray(v)) continue;
      const kept: unknown[] = [];
      for (const el of v.slice(0, CDP_EVENT_ARRAY_MAX)) {
        const r = element(el, node);
        if (r !== undefined) kept.push(r);
      }
      out[key] = kept;
      continue;
    }
    const r = element(v, node);
    if (r !== undefined) out[key] = r;
  }
  return out;
}

/** What of `params` may leave the browser's process for the event `method` (see the header). */
export function cdpEventParams(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> {
  const p = params ?? {};
  const trie = TRIES.get(method);
  if (trie === undefined) return p;
  let source = p;
  if (method === "Fetch.requestPaused" && Array.isArray(p.responseHeaders)) {
    source = { ...p, responseHeaders: p.responseHeaders.filter((h) => isRecord(h) && typeof h.name === "string" && FETCH_HEADERS.has(h.name.toLowerCase())) };
  }
  return pick(source, trie);
}
