import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * **The duplicate-composer drift tripwire** (Task 8 review m3).
 *
 * `agent/approvals.ts` holds deliberate one-phase COPIES of three private helpers in `engine.ts`:
 * `approvalCardSummary`, `suggestBashPrefix` (+ its `BASH_PREFIX_MULTI_WORD_HEADS`) and
 * `approvalOptionsFor`. The engine keeps its own copies until Task 17 deletes it, so during that
 * window a card-text edit made in only one place changes what a human reads on the Winter leg and
 * not on the engine leg — or the reverse — with every test green.
 *
 * This compares the two sources' function BODIES directly, so it needs no engine import (importing
 * `engine.ts` into a unit test costs seconds) and no duplicated expectations. Comments and
 * whitespace are stripped, because the copies deliberately carry different prose.
 *
 * **Delete this test when Task 17 deletes `engine.ts`'s copies** — at that point there is one
 * definition and nothing to drift.
 */

const SRC = join(import.meta.dir, "..", "..", "src", "agent");

/** A function/const body, comment-free and whitespace-normalized. Brace-counted rather than
 *  regex-matched, so a nested `{}` in the body cannot truncate it. */
function extractBlock(source: string, startMarker: string): string {
  const at = source.indexOf(startMarker);
  if (at < 0) throw new Error(`marker not found: ${startMarker}`);
  let i = source.indexOf("{", at);
  if (i < 0) throw new Error(`no body for: ${startMarker}`);
  let depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return normalize(source.slice(start, i));
}

function normalize(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments
    .replace(/\/\/[^\n]*/g, " ")         // line comments
    .replace(/\s+/g, " ")
    .trim();
}

const engine = readFileSync(join(SRC, "engine.ts"), "utf8");
const approvals = readFileSync(join(SRC, "approvals.ts"), "utf8");

test("approvalCardSummary has not drifted from engine.ts's copy", () => {
  expect(extractBlock(approvals, "export function approvalCardSummary("))
    .toBe(extractBlock(engine, "function approvalCardSummary("));
});

test("suggestBashPrefix and its multi-word head set have not drifted", () => {
  expect(extractBlock(approvals, "export function suggestBashPrefix("))
    .toBe(extractBlock(engine, "export function suggestBashPrefix("));
  expect(extractBlock(approvals, "const BASH_PREFIX_MULTI_WORD_HEADS = new Set("))
    .toBe(extractBlock(engine, "const BASH_PREFIX_MULTI_WORD_HEADS = new Set("));
});

test("approvalOptionsFor has not drifted from engine.ts's copy", () => {
  expect(extractBlock(approvals, "export function approvalOptionsFor("))
    .toBe(extractBlock(engine, "function approvalOptionsFor("));
});

test("the WORKFLOW_TOOL constant the summary switches on is the same literal", () => {
  const of = (s: string) => /const WORKFLOW_TOOL = ("[^"]*")/.exec(s)?.[1];
  expect(of(approvals)).toBe(of(engine));
  expect(of(approvals)).toBe('"Workflow"');
});

test("the three control-plane filenames have not drifted from engine.ts's set", () => {
  // Not a composer, but the same one-phase-duplicate shape and the same hazard: the fence in
  // `runtime-sdk/control-plane.ts` and the engine's own `CONTROL_PLANE_FILENAMES` must name the
  // same files, or the Winter leg fences a different surface than the engine leg.
  const controlPlane = readFileSync(join(SRC, "..", "runtime-sdk", "control-plane.ts"), "utf8");
  // `new Set([...])` is bracket-delimited, so the brace-counting extractor above does not apply.
  const setLiteral = (s: string, marker: string): string[] => {
    const at = s.indexOf(marker);
    if (at < 0) throw new Error(`marker not found: ${marker}`);
    const open = s.indexOf("[", at);
    const close = s.indexOf("]", open);
    return [...s.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
  };
  const fromEngine = setLiteral(engine, "const CONTROL_PLANE_FILENAMES = new Set(");
  expect(fromEngine).toEqual(["permissions.local.json", "settings.json", "settings.local.json"]);
  expect(setLiteral(controlPlane, "export const CONTROL_PLANE_FILENAMES")).toEqual(fromEngine);
});
