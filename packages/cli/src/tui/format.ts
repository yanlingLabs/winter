/** `format.ts` (Phase 3c Task 4) — the React/Ink-FREE presentation constants + helpers shared by
 *  both the Ink per-block renderers (`transcript.tsx`) and the string line-log builders
 *  (`flatten-blocks.ts`). Extracted here so `flatten-blocks.ts` (the fullscreen transcript's line
 *  source) no longer imports from a React-bearing module — the T2 purity finding: a pure line
 *  builder must not pull an Ink component graph in via a shared helper. Zero React/Ink imports.
 *
 *  `formatArgsHead`: the tool USE line's args-head cap (2 lines / 160 chars, trailing `…` on either
 *  cap), used identically by the committed tool block, the in-flight tool line, and the flattened
 *  line log. `MAX_RESULT_LINES`: the non-verbose tool-RESULT line cap (counts LINES split on "\n";
 *  a single very-long line is NOT truncated here — terminal/JS wrapping owns that — only the line
 *  COUNT is capped). */

/** Same 2-line/160-char args-head cap the tool USE line and the in-flight tool line both use — kept
 *  RAW (no re-serialization of argsJson): slice the raw string, mark either-cap truncation with a
 *  trailing `…`; an args string already within both caps passes through unchanged. */
const ARGS_HEAD_CHARS = 160;
const ARGS_HEAD_LINES = 2;

/** Result-line cap (tool blocks, and structurally anything else growing a `⎿` body): counts LINES
 *  (split on "\n"), not characters. */
export const MAX_RESULT_LINES = 10;

/** Terminal carriage returns repaint the current row. Treat pasted CR/CRLF as visual line breaks
 * while keeping the stored and submitted text byte-for-byte unchanged. */
export function displayLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function formatArgsHead(argsJson: string): string {
  const lines = argsJson.split("\n");
  let head = lines.slice(0, ARGS_HEAD_LINES).join("\n");
  let truncated = lines.length > ARGS_HEAD_LINES;
  if (head.length > ARGS_HEAD_CHARS) {
    head = head.slice(0, ARGS_HEAD_CHARS);
    truncated = true;
  }
  return truncated ? `${head}…` : head;
}

/** ComputerV2 (2026-10-08): the tool row's host name (`runtime-sdk/tool-names.ts`'s `ComputerV2` pair). */
export const COMPUTER_V2_HOST_NAME = "computer_v2";

const COMPUTER_V2_VERBS = /\.(state|find|screenshot|click|setValue|type|paste|key|scroll|drag|select|action|menu|waitForIdle|waitFor|windows|useWindow|appAt|hover|goto|back|forward|reload|text|upload)\s*\(/g;
const APPS_OPEN = /apps\s*\.\s*open\s*\(\s*(["'`])((?:(?!\1)[^\\\n])+)\1/g;
/** `browsers.open("https://example.com/…")`: the site it opens, shown as its host. */
const BROWSERS_OPEN = /browsers\s*\.\s*open\s*\(\s*(["'`])((?:(?!\1)[^\\\n]){1,300})\1/g;

function hostOf(url: string): string | undefined {
  if (url.includes("${")) return undefined;
  try {
    const host = new URL(url).host;
    return host.length === 0 ? undefined : host;
  } catch { return undefined; }
}

/**
 * ComputerV2's row label (R10): its `title` when the model gave one; else derived from the code — the app
 * names it opens (`apps.open("…")`) and the verbs it uses, e.g. "Notes · click, paste, state"; else "Using the
 * computer". Never the raw code (the row's args head would otherwise be a wall of JavaScript).
 */
export function computerV2Label(argsJson: string): string {
  let args: { title?: unknown; code?: unknown } = {};
  try { args = JSON.parse(argsJson) as typeof args; } catch { /* a partial stream: fall through */ }
  if (typeof args.title === "string" && args.title.trim().length > 0) return args.title.trim().slice(0, 80);
  const code = typeof args.code === "string" ? args.code : "";
  // Apps and sites in the order the script opens them.
  const apps = [...new Set([
    ...[...code.matchAll(APPS_OPEN)].map((m) => ({ at: m.index ?? 0, name: m[2]!.trim() })),
    ...[...code.matchAll(BROWSERS_OPEN)].map((m) => ({ at: m.index ?? 0, name: hostOf(m[2]!.trim()) ?? "" })),
  ].sort((a, b) => a.at - b.at).map((x) => x.name).filter((n) => n.length > 0))];
  const verbs = [...new Set([...code.matchAll(COMPUTER_V2_VERBS)].map((m) => m[1]!))];
  const label = [apps.join(", "), verbs.join(", ")].filter((p) => p.length > 0).join(" · ");
  return label.length === 0 ? "Using the computer" : label.slice(0, 80);
}

/** The bold name and the parenthesized head a tool row shows. ComputerV2 shows its label, never its code. */
export function toolHeadFor(name: string, argsJson: string): { name: string; head: string } {
  if (name === COMPUTER_V2_HOST_NAME || name === "ComputerV2") return { name: "ComputerV2", head: computerV2Label(argsJson) };
  return { name, head: formatArgsHead(argsJson) };
}
