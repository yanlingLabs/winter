// ComputerV2 Phase 4 — WebMCP: a site's own agent tools (`document.modelContext`), read and called from the page
// runtime's "winter" world. Pure over the page's ModelContext (passed in), so the page runtime (`main.ts`) and the
// tests' fake page run the same code.
//
// The API is a draft in an origin trial and has changed shape more than once, so everything here is FEATURE-DETECTED
// and FAILS CLOSED: a missing, throwing or wrongly shaped API, a tool that does not look as the draft says, a listing
// that does not answer in time — all read as "no site tools". Measured in Chrome for Testing 153 and 156 with
// `--enable-features=WebMCP`: `getTools()` answers every tool registered in the tab, a frame's included (each names
// its `window` and `origin`), `inputSchema` is a JSON string in 153 and an object in 156, a tool that throws rejects
// with `UnknownError`, an aborted signal with `AbortError`, and a call that navigates the page never answers (its
// world goes with the document).
//
// Every string a tool carries is the PAGE's: cut, redacted and reduced to one line here, fenced by the engine, and
// never part of telemetry.
import type { RtSiteTool, RtSiteToolAnswer, RtSiteTools } from "./protocol";
import { redactText } from "./redact";

/** A tool name, as the draft allows it: 1–128 ASCII letters, digits, `_`, `-`, `.`. Anything else is left out. */
export const SITE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export const SITE_TOOL_CAPS = {
  /** Names kept for the state line and the call check. */
  names: 200,
  /** Tools described by `tab.tools()`, and their JSON in all. */
  described: 50,
  describedBytes: 32 * 1024,
  descriptionChars: 500,
  titleChars: 120,
  schemaChars: 2_000,
  /** A tool's answer (its JSON string) handed to the engine. */
  resultChars: 256 * 1024,
  errorChars: 500,
  /** `getTools()` must answer within this. */
  listMs: 2_000,
} as const;

/** The two members Winter uses. Anything else on the page's object is ignored. */
export interface ModelContextLike {
  getTools(options?: unknown): Promise<unknown>;
  executeTool(tool: unknown, input?: unknown, options?: unknown): Promise<unknown>;
}

/** Who the runtime is: the frame's own window and origin (a tool registered elsewhere is not this page's). */
export interface SiteToolOwner { window: unknown; origin: string }

/** The page's ModelContext when it has both members, else `undefined`. Never throws. */
export function modelContextOf(doc: unknown): ModelContextLike | undefined {
  try {
    const mc = (doc as { modelContext?: unknown } | null | undefined)?.modelContext;
    if (mc === null || mc === undefined || (typeof mc !== "object" && typeof mc !== "function")) return undefined;
    const m = mc as { getTools?: unknown; executeTool?: unknown };
    if (typeof m.getTools !== "function" || typeof m.executeTool !== "function") return undefined;
    return mc as ModelContextLike;
  } catch {
    return undefined;
  }
}

const CONTROLS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]+", "g");
/** One line of the page's words: controls, bidi marks and line breaks become spaces, runs of space collapse. */
function oneLine(s: string): string { return s.replace(CONTROLS, " ").replace(/\s+/g, " ").trim(); }
function cut(s: string, n: number): string { return s.length <= n ? s : `${s.slice(0, n)}…`; }
function pageText(s: string, n: number): string { return cut(redactText(oneLine(s)), n); }

const INVISIBLE = new RegExp("[\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");
/** Page text printed as-is elsewhere (a schema's JSON, a tool's answer): the characters that can break or reorder a
 *  line where JSON leaves them alone — line and paragraph separators, bidi controls, zero-width marks — written as
 *  `\uXXXX` escapes, so nothing the page wrote can pass for a line of Winter's. */
export function escapeInvisible(s: string): string {
  return s.replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function field(o: object, k: string): unknown {
  try { return (o as Record<string, unknown>)[k]; } catch { return undefined; }
}

/** One tool as the page registered it, or `undefined` when it is not shaped as the draft says (left out). */
export function siteToolInfo(raw: unknown): RtSiteTool | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const name = field(raw, "name");
  const description = field(raw, "description");
  if (typeof name !== "string" || !SITE_TOOL_NAME.test(name) || typeof description !== "string") return undefined;
  const title = field(raw, "title");
  const info: RtSiteTool = { name, description: pageText(description, SITE_TOOL_CAPS.descriptionChars), readOnly: false, consequential: false };
  if (typeof title === "string" && oneLine(title).length > 0) info.title = pageText(title, SITE_TOOL_CAPS.titleChars);
  // The input schema: an object (Chrome 156) or its JSON string (Chrome 153); kept whole only within the cap.
  const schema = field(raw, "inputSchema");
  let json: string | undefined;
  try {
    if (typeof schema === "string") json = JSON.stringify(JSON.parse(schema));
    else if (schema !== null && typeof schema === "object") json = JSON.stringify(schema);
  } catch {
    json = typeof schema === "string" ? schema : undefined;
  }
  if (json !== undefined && json.length > 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { parsed = undefined; }
    if (json.length <= SITE_TOOL_CAPS.schemaChars && parsed !== null && typeof parsed === "object") info.inputSchema = parsed;
    else info.schemaText = pageText(json, SITE_TOOL_CAPS.schemaChars);
  }
  const ann = field(raw, "annotations");
  if (ann !== null && typeof ann === "object") {
    info.readOnly = field(ann, "readOnlyHint") === true;
    info.consequential = field(ann, "consequentialHint") === true;
  }
  return info;
}

/** `p` within `ms`, else a rejection. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

/** A tool's name when it is shaped as the draft says (a valid name and a description) — the cheap check a state's line
 *  and a call need; `siteToolInfo` reads the rest only when tools are described. */
function siteToolName(raw: object): string | undefined {
  const name = field(raw, "name");
  return typeof name === "string" && SITE_TOOL_NAME.test(name) && typeof field(raw, "description") === "string" ? name : undefined;
}

/** The page's tools for THIS frame: those whose `window` is its own and whose `origin` is its own — a frame's tools are
 *  never the page's. Duplicate names keep the first. Each element of the answer is checked as it is read. */
async function ownTools(mc: ModelContextLike, own: SiteToolOwner, listMs: number): Promise<Array<{ raw: object; name: string }> | null> {
  let raw: unknown;
  try { raw = await within(Promise.resolve(mc.getTools()), listMs); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const out: Array<{ raw: object; name: string }> = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, 1_000) as unknown[]) {
    if (r === null || typeof r !== "object") continue;
    if (field(r, "window") !== own.window || field(r, "origin") !== own.origin) continue;
    const name = siteToolName(r);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    out.push({ raw: r, name });
  }
  return out;
}

/** The page's own tools: every name (≤ 200), and — `describe` — the first ones described within the caps. `null`
 *  when the page has no usable ModelContext (the same as no tools, to the model). */
export async function listSiteTools(mc: ModelContextLike | undefined, own: SiteToolOwner, o: { describe?: boolean; listMs?: number } = {}): Promise<RtSiteTools | null> {
  if (mc === undefined) return null;
  const tools = await ownTools(mc, own, o.listMs ?? SITE_TOOL_CAPS.listMs);
  if (tools === null) return null;
  const names = tools.slice(0, SITE_TOOL_CAPS.names).map((t) => t.name);
  if (o.describe !== true) return { names, total: tools.length };
  const described: RtSiteTool[] = [];
  let bytes = 0;
  for (const t of tools.slice(0, SITE_TOOL_CAPS.described)) {
    const info = siteToolInfo(t.raw);
    if (info === undefined) continue;
    const size = JSON.stringify(info).length;
    if (described.length > 0 && bytes + size > SITE_TOOL_CAPS.describedBytes) break;
    bytes += size;
    described.push(info);
  }
  return { names, total: tools.length, tools: described, more: tools.length - described.length };
}

const errorName = (e: unknown): string => {
  const n = e !== null && typeof e === "object" ? field(e, "name") : undefined;
  return typeof n === "string" && /^[A-Za-z]{1,40}$/.test(n) ? n : "Error";
};
const errorMessage = (e: unknown): string => {
  const m = e !== null && typeof e === "object" ? field(e, "message") : e;
  return pageText(typeof m === "string" ? m : String(m), SITE_TOOL_CAPS.errorChars);
};

/**
 * Run one tool. The input's FORM differs by browser version: a JSON string (Chrome 151–153) or an object (Chrome 155+).
 * The JSON string goes first, and only a `TypeError` — WebIDL's conversion failure, thrown BEFORE the tool runs — is
 * retried with the object. The other order is unsafe: an object passed where a string is expected is coerced to
 * "[object Object]", and a browser that parsed that leniently would run the tool with garbage. A tool's own failure
 * never reads as a `TypeError` (the browser reports it as `UnknownError`), so the tool never runs twice.
 */
export async function executeSiteTool(mc: ModelContextLike, tool: object, input: unknown, signal: AbortSignal): Promise<unknown> {
  const json = JSON.stringify(input ?? {});
  try {
    return await mc.executeTool(tool, json, { signal });
  } catch (e) {
    if (signal.aborted || !(e instanceof TypeError || errorName(e) === "TypeError")) throw e;
  }
  return await mc.executeTool(tool, JSON.parse(json) as unknown, { signal });
}

/** The calls in flight in one document, each abortable by its id. */
export class SiteToolCalls {
  private readonly pending = new Map<string, AbortController>();

  async call(mc: ModelContextLike | undefined, own: SiteToolOwner, a: { name: string; input: unknown; callId: string }): Promise<RtSiteToolAnswer> {
    if (mc === undefined || typeof a.name !== "string" || typeof a.callId !== "string") return { ok: false, reason: "unknown" };
    // The tool must be one this document offers NOW (the list the model read may be from an earlier page).
    const tools = await ownTools(mc, own, SITE_TOOL_CAPS.listMs);
    const hit = tools?.find((t) => t.name === a.name);
    if (hit === undefined) return { ok: false, reason: "unknown" };
    const ac = new AbortController();
    this.pending.set(a.callId, ac);
    try {
      const result = await executeSiteTool(mc, hit.raw, a.input, ac.signal);
      // A tool that returns nothing answers the bare string "undefined" (measured, Chrome 153 and 156): no answer.
      if (result === null || result === undefined || result === "undefined") return { ok: true, result: null };
      const text = typeof result === "string" ? result : (() => { try { return JSON.stringify(result) ?? String(result); } catch { return String(result); } })();
      return text.length > SITE_TOOL_CAPS.resultChars ? { ok: true, result: text.slice(0, SITE_TOOL_CAPS.resultChars), cut: true } : { ok: true, result: text };
    } catch (e) {
      if (ac.signal.aborted) return { ok: false, reason: "aborted" };
      return { ok: false, reason: "failed", name: errorName(e), message: errorMessage(e) };
    } finally {
      this.pending.delete(a.callId);
    }
  }

  /** Abort a call in flight; `false` when none has that id (it settled already). */
  cancel(callId: unknown): boolean {
    const ac = typeof callId === "string" ? this.pending.get(callId) : undefined;
    if (ac === undefined) return false;
    ac.abort();
    return true;
  }
}
