// ComputerV2 Phase 2 — what the hand-written adapters share: the script frame every one of their AppleScripts runs in
// (the app named ONLY as `application id "<its bundle id>"`, the one form the helper's source check accepts whatever
// the app's localized name; the handlers and the tab/newline constants set before the `tell`, where no app's own
// `tab` class can shadow them), argument checks, and the reading of the rows a script returns.
//
// Every script here only READS the app or does the one thing its extra says. None of them uses `activate`, `do shell
// script`, a dialog, a file read or write, another app, or JavaScript — the helper refuses all of those anyway.
import { homedir } from "node:os";
import { normalize } from "node:path";
import { asFile, asString } from "../dict";

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });

/** The handlers a script may call with `my …` (defined outside the `tell`, so their words are AppleScript's own). */
const HANDLERS = {
  text: [
    "on winterText(v)",
    "  if v is missing value then return \"\"",
    "  return v as text",
    "end winterText",
  ],
  iso: [
    "on winterPad(n)",
    "  return text -2 thru -1 of (\"0\" & (n as text))",
    "end winterPad",
    "on winterISO(d)",
    "  if d is missing value then return \"\"",
    "  set s to time of d",
    "  return ((year of d) as text) & \"-\" & my winterPad((month of d) as integer) & \"-\" & my winterPad(day of d) & \"T\" & my winterPad(s div 3600) & \":\" & my winterPad((s mod 3600) div 60) & \":\" & my winterPad(s mod 60)",
    "end winterISO",
  ],
  min: [
    "on winterMin(a, b)",
    "  if a < b then return a",
    "  return b",
    "end winterMin",
  ],
} as const;

/**
 * One adapter script: `body` runs inside `tell application id "<bundleId>"`. Rows are joined with `winterTAB` /
 * `winterLF` (set before the tell); `handlers` adds `winterText(v)` (missing value → "") and `winterISO(date)`.
 */
export function appScript(bundleId: string, body: string[], opts: { handlers?: Array<keyof typeof HANDLERS> } = {}): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundleId)) throw bad("the bound app has no usable bundle id");
  const handlers = (opts.handlers ?? []).flatMap((h) => [...HANDLERS[h]]);
  return [
    "set winterTAB to tab",
    "set winterLF to linefeed",
    "set winterCR to return",
    ...handlers,
    `tell application id "${bundleId}"`,
    ...body.map((l) => `  ${l}`),
    "end tell",
  ].join("\n");
}

/** A string argument as an AppleScript expression (newline/return/tab joined in with the frame's variables). */
export function text(s: string): string {
  return asString(s);
}

/** An existing absolute path as `(POSIX file "…")`. */
export function posixFile(path: string): string {
  return asFile(path);
}

/** A path argument: a string, absolute or `~/…`, normalised (no `..` left), no control characters. */
export function pathArg(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim().length === 0) throw bad(`${what} takes a path`);
  const raw = v.trim();
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw bad(`${what}: a path may not hold control characters`);
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? `${homedir()}/${raw.slice(2)}` : raw;
  if (!expanded.startsWith("/")) throw bad(`${what} takes an absolute path (or ~/…)`);
  const p = normalize(expanded);
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** An optional options object (the extras' second argument). */
export function optsArg(v: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw bad(`${what} takes an options object { ${keys.join(", ")} }`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`${what} has no option "${k.slice(0, 40)}" — it takes ${keys.join(", ")}`);
  return o;
}

export function stringArg(v: unknown, what: string, max = 10_000): string {
  if (typeof v !== "string") throw bad(`${what} takes a string`);
  if (v.length > max) throw bad(`${what} is at most ${max.toLocaleString("en-US")} characters`);
  return v;
}

export function intArg(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} takes a whole number from ${min} to ${max}`);
  return v;
}

/** A URL a browser extra may load: http(s), or a file URL of an absolute path. */
export function urlArg(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 4_096) throw bad(`${what} takes a URL (at most 4,096 characters)`);
  if (/[\u0000- \u007f]/.test(v)) throw bad(`${what}: a URL may not hold spaces or control characters (encode them)`);
  let u: URL;
  try { u = new URL(v); } catch { throw bad(`${what}: "${v.slice(0, 80)}" is not a URL`); }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") throw bad(`${what} opens http, https and file URLs only`);
  return v;
}

/** The rows a script returned: one per line, its fields split by tab — the LAST field keeps any tab it held. */
export function rows(result: string | null, fields: number): string[][] {
  if (result === null || result.length === 0) return [];
  const out: string[][] = [];
  for (const line of result.split(/\r?\n|\r/)) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < fields) continue;
    out.push([...parts.slice(0, fields - 1), parts.slice(fields - 1).join("\t")]);
  }
  return out;
}

/** AppleScript's `true`/`false` as text. */
export const yes = (s: string | undefined): boolean => s?.trim().toLowerCase() === "true";
