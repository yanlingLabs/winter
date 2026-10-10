// ComputerV2 Phase 2 — `app.dict.<name>(…)`: typed wrappers GENERATED from the bound app's scripting dictionary
// (`target.scriptingCommands`, helper 1.8.0), each one run exactly like `app.applescript()` — through
// `target.applescript`, so the helper's checks (the source, its decompiled text, every Apple Event) still apply.
//
//   - NAMES: the terminology in camelCase (`check for new mail` → `checkForNewMail`), `/^[a-z][A-Za-z0-9]{0,47}$/`; a
//     collision (or a name every object already answers, like `then`) gets the suffix `2`. Parameter keys likewise.
//   - WRAPPED: a command whose required parameters are all text, number/integer/real, boolean, file/alias, a specifier
//     (an object reference — the app's own classes are specifiers too, and so is `type`), an enumeration, `any`, or a
//     list of those. Any other required type (a record, a date, …) means no wrapper; `help("dict")` says "use
//     applescript()". An optional parameter of another type is simply not offered.
//   - DROPPED: hidden commands (the helper drops them), `run`, `reopen`, `activate`, `launch`, and every command the
//     helper refuses anyway (a JavaScript door, `open location`, Standard Additions) — never offered, never failing late.
//   - THE SOURCE: `tell application id "<bundleId>"` / `<terminology> <direct> <label value>…` / `end tell`, values
//     marshalled here: strings escaped (newline, return and tab joined in as variables set before the `tell`, where no
//     app's own `tab` class can shadow the constant), finite numbers, `true`/`false`, `{ file }` → `(POSIX file "…")`
//     for an absolute path, an enumerator emitted bare, `{ ref }` inserted as written (one line, ≤ 500 characters, no
//     `«`, `tell`, `application` or `app` token and no comment outside its strings), arrays as `{a, b}`.
import type { ScriptingCommandsResult } from "../protocol";

export type DictValue = string | number | boolean | { file: string } | { ref: string } | DictValue[];

type BaseKind = "text" | "number" | "integer" | "boolean" | "file" | "ref" | "any" | "enum";
interface TypeAlt { kind: BaseKind; list: boolean; declared: string; enumerators?: string[] }
export interface DictType { alts: TypeAlt[]; declared: string }

export interface DictParam { key: string; term: string; type: DictType; optional: boolean; description?: string }
export interface DictCommand {
  /** The wrapper's name (`checkForNewMail`). */
  name: string;
  /** The AppleScript terminology (`check for new mail`). */
  term: string;
  eventCode: string;
  suite: string;
  description?: string;
  direct?: { type: DictType; optional: boolean; description?: string };
  params: DictParam[];
  result?: string;
}
export interface DictInfo {
  scriptable: boolean;
  bundleVersion?: string;
  commands: DictCommand[];
  /** Commands with no wrapper, and why (`help("dict")` lists them with "use applescript()"). */
  unwrapped: Array<{ term: string; why: string; description?: string }>;
  /** The helper listed only its first 300 commands. */
  truncated: boolean;
}

export const DICT_NAME = /^[a-z][A-Za-z0-9]{0,47}$/;
/** Never wrapped: they would bring the app forward (or run it), which no script may do. */
const DROPPED_NAMES = new Set(["run", "reopen", "activate", "launch"]);
/** The helper's refused events (`CUAppleScriptPolicy.refusedAnywhere` / `refusedClasses`), mirrored so a command it would
 *  refuse is never offered — the helper stays the check. */
const REFUSED_EVENT_KEYS = new Set([
  "fndr/gstl", "GURL/GURL", "ears/lfdr", "misc/actv", "aevt/rapp", "aevt/oapp", "sfri/dojs", "ascr/psbr", "CrSu/ExJa",
]);
const REFUSED_EVENT_CLASSES = new Set(["syso", "rdwr", "Jons", "prcs"]);
/** Names every object answers (or that `await` reads): a command named like one takes the suffix. */
const RESERVED_NAMES = new Set([
  "then", "constructor", "toString", "toJSON", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
  "toLocaleString", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);
/** Terminology the source may hold bare: plain words. */
const TERM = /^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/;
/** Words a bare term may not contain: the helper's source check reads `app`/`application` as an app specifier. */
const FORBIDDEN_WORDS = /\b(?:app|application|tell)\b/i;

/** Value types a wrapper does not take (no faithful JSON form). Anything else that is not a primitive is the app's own
 *  class, i.e. an object reference. */
const UNWRAPPABLE = new Set(["record", "date", "point", "rectangle", "bounding rectangle", "data", "property", "rgb color", "missing value", "picture"]);
const PRIMITIVES: Record<string, BaseKind> = {
  "text": "text", "string": "text", "unicode text": "text", "international text": "text", "styled text": "text",
  "number": "number", "real": "number", "double": "number",
  "integer": "integer", "double integer": "integer", "small integer": "integer",
  "boolean": "boolean",
  "file": "file", "alias": "file", "file specification": "file", "file url": "file",
  "specifier": "ref", "location specifier": "ref", "object specifier": "ref", "reference": "ref", "type": "ref",
  "any": "any",
};

/** `check for new mail` → `checkForNewMail`; undefined when nothing usable is left. */
export function camelName(term: string): string | undefined {
  const words = term.trim().split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  if (words.length === 0) return undefined;
  const [first, ...rest] = words as [string, ...string[]];
  return first.charAt(0).toLowerCase() + first.slice(1) + rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base) && !RESERVED_NAMES.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate) && !RESERVED_NAMES.has(candidate)) return candidate;
  }
}

/** One declared type (`file | list of file`, `account | folder`) as what a wrapper accepts; undefined: not wrappable. */
export function parseDictType(declared: string, enumerators?: readonly string[]): DictType | undefined {
  const enums = (enumerators ?? []).filter((e) => TERM.test(e) && !FORBIDDEN_WORDS.test(e));
  const alts: TypeAlt[] = [];
  for (const raw of declared.split("|").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const list = /^list of /i.test(raw) || raw.toLowerCase() === "list";
    const base = raw.toLowerCase() === "list" ? "any" : raw.replace(/^list of /i, "").trim();
    const key = base.toLowerCase();
    if (UNWRAPPABLE.has(key)) continue;
    const primitive = PRIMITIVES[key];
    if (primitive !== undefined) { alts.push({ kind: primitive, list, declared: base }); continue; }
    if (enums.length > 0) { alts.push({ kind: "enum", list, declared: base, enumerators: enums }); continue; }
    // The app's own class (`message`, `document`, `tab`): an object reference, written as `{ ref }`.
    if (TERM.test(base)) alts.push({ kind: "ref", list, declared: base });
  }
  return alts.length === 0 ? undefined : { alts, declared };
}

const eventKey = (code: string): string => `${code.slice(0, 4)}/${code.slice(4, 8)}`;

/** The wrappers for one app, from its `target.scriptingCommands` answer. Pure. */
export function generateDict(res: ScriptingCommandsResult): DictInfo {
  const info: DictInfo = {
    scriptable: res.scriptable === true, commands: [], unwrapped: [], truncated: res.truncated === true,
    ...(typeof res.bundleVersion === "string" ? { bundleVersion: res.bundleVersion } : {}),
  };
  if (!info.scriptable || !Array.isArray(res.commands)) return info;
  const taken = new Set<string>();
  for (const c of res.commands) {
    if (c === null || typeof c !== "object" || typeof c.name !== "string" || typeof c.eventCode !== "string") continue;
    const term = c.name.trim();
    if (DROPPED_NAMES.has(term.toLowerCase())) continue;
    if (c.eventCode.length !== 8) continue;
    if (REFUSED_EVENT_KEYS.has(eventKey(c.eventCode)) || REFUSED_EVENT_CLASSES.has(c.eventCode.slice(0, 4))) continue;
    const params = Array.isArray(c.params) ? c.params : [];
    // A JavaScript door by any name (Safari's `do JavaScript`, a browser's `execute … javascript`): never offered.
    if (/javascript/i.test(term) || params.some((p) => /javascript/i.test(String(p?.name ?? "")))) continue;
    const description = typeof c.description === "string" && c.description.length > 0 ? c.description.slice(0, 200) : undefined;
    const no = (why: string): void => { info.unwrapped.push({ term, why, ...(description === undefined ? {} : { description }) }); };
    if (!TERM.test(term) || FORBIDDEN_WORDS.test(term)) { no("its name can't be written into a script here"); continue; }
    const base = camelName(term);
    if (base === undefined || !DICT_NAME.test(base)) { no("its name can't be made a function name"); continue; }
    let direct: DictCommand["direct"];
    if (c.direct !== undefined && c.direct !== null) {
      const type = parseDictType(String(c.direct.type ?? "any"));
      if (type === undefined) {
        if (c.direct.optional !== true) { no(`its direct parameter takes ${String(c.direct.type)}`); continue; }
      } else {
        direct = { type, optional: c.direct.optional === true, ...(typeof c.direct.description === "string" ? { description: c.direct.description.slice(0, 200) } : {}) };
      }
    }
    const keys = new Set<string>();
    const wrapped: DictParam[] = [];
    let refusal: string | undefined;
    for (const p of params) {
      if (p === null || typeof p !== "object" || typeof p.name !== "string") continue;
      const pterm = p.name.trim();
      const type = parseDictType(String(p.type ?? "any"), Array.isArray(p.enumerators) ? p.enumerators.filter((e): e is string => typeof e === "string") : undefined);
      const usable = type !== undefined && TERM.test(pterm) && !FORBIDDEN_WORDS.test(pterm) && camelName(pterm) !== undefined && DICT_NAME.test(camelName(pterm)!);
      if (!usable) {
        if (p.optional !== true) { refusal = `its "${pterm}" parameter takes ${String(p.type)}`; break; }
        continue;
      }
      const key = uniqueName(camelName(pterm)!, keys);
      keys.add(key);
      wrapped.push({ key, term: pterm, type: type!, optional: p.optional === true, ...(typeof p.description === "string" && p.description.length > 0 ? { description: p.description.slice(0, 200) } : {}) });
    }
    if (refusal !== undefined) { no(refusal); continue; }
    const name = uniqueName(base, taken);
    taken.add(name);
    info.commands.push({
      name, term, eventCode: c.eventCode, suite: typeof c.suite === "string" ? c.suite : "",
      ...(description === undefined ? {} : { description }),
      ...(direct === undefined ? {} : { direct }),
      params: wrapped,
      ...(typeof c.result?.type === "string" ? { result: c.result.type } : {}),
    });
  }
  return info;
}

// ── marshalling ─────────────────────────────────────────────────────────────────────────────────────────────────

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });

/** The variables a source may need before its `tell` (an app's own `tab` class must never shadow the constant). */
interface Needs { lf: boolean; cr: boolean; tab: boolean }

/** An AppleScript string expression: `"…"`, or a parenthesised join with the newline/return/tab variables. */
export function asString(s: string, needs: Needs = { lf: false, cr: false, tab: false }): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw bad("a string may not hold control characters other than newline, return and tab");
  const parts: string[] = [];
  let cur = "";
  const flush = (): void => { parts.push(`"${cur.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`); cur = ""; };
  for (const ch of s) {
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      flush();
      if (ch === "\n") { parts.push("winterLF"); needs.lf = true; }
      else if (ch === "\r") { parts.push("winterCR"); needs.cr = true; }
      else { parts.push("winterTAB"); needs.tab = true; }
    } else cur += ch;
  }
  flush();
  return parts.length === 1 ? parts[0]! : `(${parts.join(" & ")})`;
}

/** A finite number as AppleScript writes it (`1.5E+21`), parenthesised when negative. */
export function asNumber(n: number, integer: boolean): string {
  if (!Number.isFinite(n)) throw bad("numbers must be finite");
  if (integer && !Number.isInteger(n)) throw bad("that parameter takes a whole number");
  let s = String(n);
  const m = /^(-?\d+(?:\.\d+)?)e([+-]\d+)$/.exec(s);
  if (m !== null) s = `${m[1]!.includes(".") ? m[1] : `${m[1]}.0`}E${m[2]}`;
  return n < 0 ? `(${s})` : s;
}

/** `{ file: "/abs" }` → `(POSIX file "/abs")`. */
export function asFile(path: unknown, needs?: Needs): string {
  if (typeof path !== "string" || !path.startsWith("/")) throw bad("{ file } takes an absolute path");
  if (/[\u0000-\u001f\u007f]/.test(path)) throw bad("{ file } paths may not hold control characters");
  return `(POSIX file ${asString(path, needs)})`;
}

/** `{ ref }`: inserted as written — after these checks (the helper checks the whole script again). */
export function checkRef(ref: unknown): string {
  if (typeof ref !== "string" || ref.trim().length === 0) throw bad("{ ref } takes an AppleScript reference, such as 'note \"Groceries\"'");
  if (ref.length > 500) throw bad("{ ref } is at most 500 characters");
  if (/[\u0000-\u001f\u007f¬]/.test(ref)) throw bad("{ ref } must be one line, with no control or continuation characters");
  if (/[«»]|<<|>>/.test(ref)) throw bad("{ ref } may not use raw codes («…»)");
  // The code outside its strings: no comment, no `tell`/`application`/`app` (naming an app launches it).
  let code = "";
  let inString = false;
  for (let i = 0; i < ref.length; i++) {
    const ch = ref[i]!;
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") inString = false;
      code += " ";
      continue;
    }
    if (ch === "\"") { inString = true; code += " "; continue; }
    code += ch;
  }
  if (inString) throw bad("{ ref } has an unterminated string");
  if (/--|#|\(\*|\*\)/.test(code)) throw bad("{ ref } may not hold a comment");
  if (/\b(?:tell|application|app)\b/i.test(code)) throw bad("{ ref } may not name an app or use tell — it is inside the bound app's tell block already");
  return ref.trim();
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKey = (v: Record<string, unknown>, key: string): boolean => Object.keys(v).length === 1 && Object.hasOwn(v, key);

function marshalAlt(v: unknown, alt: TypeAlt, needs: Needs, inList: boolean): string | undefined {
  if (alt.list && !inList) {
    if (!Array.isArray(v)) return undefined;
    if (v.length > 1_000) throw bad("a list is at most 1,000 items");
    const items: string[] = [];
    for (const item of v) {
      const m = marshalAlt(item, alt, needs, true);
      if (m === undefined) return undefined;
      items.push(m);
    }
    return `{${items.join(", ")}}`;
  }
  switch (alt.kind) {
    case "text": return typeof v === "string" ? asString(v, needs) : undefined;
    case "number": return typeof v === "number" ? asNumber(v, false) : undefined;
    case "integer": return typeof v === "number" && Number.isInteger(v) ? asNumber(v, true) : undefined;
    case "boolean": return typeof v === "boolean" ? String(v) : undefined;
    case "file": return isObj(v) && onlyKey(v, "file") ? asFile(v.file, needs) : undefined;
    case "ref":
      if (isObj(v) && onlyKey(v, "ref")) return checkRef(v.ref);
      if (isObj(v) && onlyKey(v, "file")) return asFile(v.file, needs);
      return undefined;
    case "enum": {
      if (typeof v !== "string") return undefined;
      const hit = alt.enumerators?.find((e) => e.toLowerCase() === v.trim().toLowerCase());
      return hit;
    }
    case "any": return marshalAny(v, needs);
  }
}

function marshalAny(v: unknown, needs: Needs): string | undefined {
  if (typeof v === "string") return asString(v, needs);
  if (typeof v === "number") return asNumber(v, false);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length > 1_000) throw bad("a list is at most 1,000 items");
    const items = v.map((x) => marshalAny(x, needs));
    return items.every((x) => x !== undefined) ? `{${items.join(", ")}}` : undefined;
  }
  if (isObj(v) && onlyKey(v, "file")) return asFile(v.file, needs);
  if (isObj(v) && onlyKey(v, "ref")) return checkRef(v.ref);
  return undefined;
}

/** How a declared type reads in `help("dict")`. */
export function typeLabel(t: DictType): string {
  return t.alts.map((a) => {
    const one = a.kind === "text" ? "string" : a.kind === "number" ? "number" : a.kind === "integer" ? "integer" : a.kind === "boolean" ? "boolean"
      : a.kind === "file" ? "{ file }" : a.kind === "any" ? "any" : a.kind === "enum" ? (a.enumerators ?? []).map((e) => JSON.stringify(e)).join(" | ")
      : `ref<${a.declared}>`;
    return a.list ? (a.kind === "enum" ? `(${one})[]` : `${one}[]`) : one;
  }).join(" | ");
}

/** One value for one declared type; a TypeError naming `what` when it does not fit. */
export function marshal(v: unknown, t: DictType, what: string, needs: Needs): string {
  for (const alt of t.alts) {
    const m = marshalAlt(v, alt, needs, false);
    if (m !== undefined) return m;
  }
  throw bad(`${what} takes ${typeLabel(t)}`);
}

/**
 * The script for one call — `(direct?, params?)` for a command with a direct parameter, `(params?)` without. With an
 * OPTIONAL direct parameter, a lone plain object that is neither `{ file }` nor `{ ref }` is read as the params.
 */
export function buildDictSource(bundleId: string, cmd: DictCommand, args: readonly unknown[]): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundleId)) throw bad("the bound app has no usable bundle id");
  const fn = `dict.${cmd.name}()`;
  let direct: unknown;
  let params: unknown;
  if (cmd.direct !== undefined) {
    const lonePlain = args.length === 1 && isObj(args[0]) && !onlyKey(args[0], "file") && !onlyKey(args[0], "ref");
    if (cmd.direct.optional && lonePlain) params = args[0];
    else { direct = args[0]; params = args[1]; }
    if (args.length > 2) throw bad(`${fn} takes (direct, params?)`);
  } else {
    params = args[0];
    if (args.length > 1) throw bad(`${fn} takes (params?)`);
  }
  if (params !== undefined && !isObj(params)) throw bad(`${fn}: the parameters are an object { ${cmd.params.map((p) => p.key).join(", ")} }`);
  const needs: Needs = { lf: false, cr: false, tab: false };
  let line = cmd.term;
  if (cmd.direct !== undefined) {
    if (direct === undefined || direct === null) {
      if (!cmd.direct.optional) throw bad(`${fn} needs its direct parameter (${typeLabel(cmd.direct.type)})`);
    } else {
      line += ` ${marshal(direct, cmd.direct.type, `${fn}'s direct parameter`, needs)}`;
    }
  }
  const given = (params ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!cmd.params.some((p) => p.key === key)) {
      throw bad(`${fn} has no parameter "${key.slice(0, 60)}"${cmd.params.length > 0 ? ` — it takes ${cmd.params.map((p) => p.key).join(", ")}` : ""}`);
    }
  }
  for (const p of cmd.params) {
    const v = given[p.key];
    if (v === undefined || v === null) {
      if (!p.optional) throw bad(`${fn} needs { ${p.key} } (${typeLabel(p.type)})`);
      continue;
    }
    line += ` ${p.term} ${marshal(v, p.type, `${fn}'s ${p.key}`, needs)}`;
  }
  const pre = [needs.lf ? "set winterLF to linefeed" : "", needs.cr ? "set winterCR to return" : "", needs.tab ? "set winterTAB to tab" : ""].filter((l) => l.length > 0);
  return [...pre, `tell application id "${bundleId}"`, line, "end tell"].join("\n");
}

/** One line of `help("dict")` for a wrapped command. */
export function commandLine(c: DictCommand): string {
  const parts: string[] = [];
  if (c.direct !== undefined) parts.push(`${c.direct.optional ? "direct?" : "direct"}: ${typeLabel(c.direct.type)}`);
  if (c.params.length > 0) parts.push(`{ ${c.params.map((p) => `${p.key}${p.optional ? "?" : ""}: ${typeLabel(p.type)}`).join(", ")} }`);
  const desc = c.description === undefined ? "" : ` — ${c.description.replace(/\s+/g, " ").trim()}`;
  return `${c.name}(${parts.join(", ")})${desc}`;
}

export const DICT_LISTING_CAP = 6_000;

/** `help("dict", { search })`: the wrapped commands (and those with none), at most 6,000 bytes. */
export function dictListing(appName: string, info: DictInfo, search?: string): string {
  if (!info.scriptable) return `${appName} is not scriptable (it has no scripting dictionary)`;
  const q = search?.trim().toLowerCase();
  const hit = (...texts: Array<string | undefined>): boolean => q === undefined || q.length === 0 || texts.some((t) => t?.toLowerCase().includes(q) === true);
  const lines: string[] = [];
  for (const c of info.commands) {
    if (hit(c.name, c.term, c.description, ...c.params.flatMap((p) => [p.key, p.term]))) lines.push(`  ${commandLine(c)}`);
  }
  for (const u of info.unwrapped) {
    if (hit(u.term, u.description)) lines.push(`  ${u.term} — use applescript() (${u.why})`);
  }
  const head = `${appName} dictionary commands${q ? ` matching "${search!.trim().slice(0, 60)}"` : ""} — .dict.<name>(…), run like applescript() (full access). `
    + "A command with a direct parameter takes (direct, params?), one without takes (params?). Values: strings, numbers, booleans, "
    + "{ file: \"/absolute/path\" }, { ref: \"<an AppleScript reference, e.g. note \\\"Groceries\\\">\" } for ref<…>, an enumerator as a string, arrays.";
  if (lines.length === 0) return `${head}\n  (${q ? "nothing matches — try a shorter search, or none" : "no commands"})`;
  const out = [head];
  let size = Buffer.byteLength(head) + 1;
  let shown = 0;
  for (const l of lines) {
    const cost = Buffer.byteLength(l) + 1;
    if (size + cost > DICT_LISTING_CAP - 120) break;
    out.push(l);
    size += cost;
    shown++;
  }
  if (shown < lines.length) out.push(`… ${lines.length - shown} more — narrow it with { search }: help("dict", { search: "…" })`);
  else if (info.truncated) out.push("… the app has more commands than Winter lists (300) — narrow it with { search }");
  return out.join("\n");
}
