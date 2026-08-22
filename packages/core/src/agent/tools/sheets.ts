import { z } from "zod";
import { OFFICE_DEADLINES_MS, officeCommandArgs, type OfficeCommandAction } from "../../panel/office-commands";
import type { ToolRegistry } from "./registry";
import type { PanelCommandAction, PanelCommandOutcome } from "../../panel/commands";
import type { SessionDirs } from "../../sessions/dirs";
import { canHostPanel } from "./browser";

/**
 * `sheets` (office-agent-tools T3, task-3-brief.md; design
 * `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §1-§5) — the agent's first two
 * real office verbs: `info` and `read`. Everything else `sheets` will eventually do (`set`,
 * `insert_rows`, …) is Task 4's; this file registers ONLY `info`/`read` today, deliberately — the
 * model is never told about a verb this build cannot yet perform (contrast Task 1's app-side
 * `OfficeCommandConsumer`, which DOES answer all 22 for wire-completeness reasons that do not apply
 * to a tool schema no agent has reached yet).
 *
 * ## The shape, modelled on `browser.ts` deliberately and closely
 *
 * Same split this file's own sibling already established for the identical daemon/app bridge:
 *
 *  - `info` is ALSO the drivability probe (spec §1/§3, mirroring `browser tabs`) — but unlike
 *    `tabs`, `info` is NOT answered by the daemon alone; it still has to reach the app (sheet names
 *    live in the document, which only LibreOfficeKit can read). What `info` shares with `tabs` is
 *    only the ROLE, not the mechanism: both are where a caller with no verb-specific state yet
 *    should start.
 *  - Both verbs ride `PanelCommandRegistry.dispatch`, exactly as every browser COMMAND verb does: a
 *    `panel_command` transient, a pending entry keyed by `commandId`, a promise that always settles
 *    as a result or a timeout.
 *
 * ## Two refusals this file owns, that `browser.ts` never had to (spec §5)
 *
 * **The fence.** Office reads are not ordinary reads — spec §5's amended ruling: an office read
 * COPIES the target file into the helper's own state directory and parses it with LibreOffice (an
 * ingest, not an inspection), so it does NOT fall under the standing unrestricted-reads rule that
 * governs `read`/`glob`/`grep`/`ls`. v1 office tools, read or write, are working-directories-only —
 * narrower than `write`/`edit`'s own `resolveWithinAny` (which also allows tmp/outputs/one-shot
 * grants). `officeSheetsResolvedPathWithinFence` below enforces exactly that, independently of the
 * Swift-side backstop (`OfficeAgentBroker`'s own fence, task 2) — **and it must run BEFORE the reach
 * check**, not after: spec §5's own words are "a probe outside the working dirs answers with the
 * fence refusal, not the app-not-running one." If reach ran first, a probe against a path that could
 * never be allowed anyway would be told "the Mac app isn't running" whenever it happens to also be
 * true, which is a confusing accident of timing rather than the actual reason for the refusal. Fence
 * first makes the refusal depend only on the path, never on whether the app happens to be attached
 * at that instant.
 *
 * **`officeReach`.** Mirrors `browser.ts`'s own `panelReach` closely (reusing its exported
 * `canHostPanel` predicate rather than re-deriving "which attached client could plausibly answer" a
 * second time) but is its OWN function with OFFICE's own wording — not imported, not shared,
 * deliberately: the two tools answer through the same `panel_command` bridge but have nothing else
 * to say to each other (the identical non-coupling posture `OfficeCommandConsumer.swift`'s own
 * header states for its Swift half of this same design).
 *
 * ## The timeout wording Task 4 inherits verbatim
 *
 * `officeTimeoutMessage` is exported for exactly one reason: Task 4's write verbs (`set`,
 * `insert_rows`, …) ride the identical `PanelCommandOutcome.timeout` shape and MUST say the same
 * thing — spec §4's durable contract, restated here rather than re-derived: **a timeout means
 * OUTCOME UNKNOWN, never "it did not happen."** For `info`/`read` the practical consequence is mild
 * (a re-read is harmless); for a write verb it is the difference between a safe retry and a doubled
 * mutation. This file does not invent a retry loop — it states the fact plainly and lets the CALLER
 * (a model, or a future auto-retry mechanism) decide what to do with it.
 */

// ================================================================================================
// Operands
// ================================================================================================

const SheetsArgs = z.object({
  verb: z.enum(["info", "read"]),
  /** Absolute (or, mirroring `resolveWithinAny`, resolved against the session's primary working
   *  directory if relative) — spec §2's own table. Required for both verbs; a missing path is
   *  malformed, never defaulted (this file's own wire-strictness rule, matching the Swift broker's
   *  identical posture for the same operand). */
  path: z.string().min(1).max(4096),
  /** `read` only — the sheet NAME (never an index): resolved to a part index app-side, where
   *  `getPartName` lives (`OfficeWireFrame.sheetsRead`'s own header explains why that resolution
   *  cannot happen here). */
  sheet: z.string().min(1).max(512).optional(),
  /** `read` only — an A1 range: a single cell ("A1") or a two-corner span ("A1:C10"). Validated
   *  SYNTACTICALLY here (a cheap regex, catching an obviously malformed string before a round trip)
   *  — the real A1 SEMANTICS (letters<->column math) and the cell-count CAP live app-side
   *  (`PanelDocumentTab.swift`'s `officeParseRange`/`officeReadRangeMaxCells`), deliberately not
   *  reimplemented here: Stage B T8 built that conversion once, in Swift, and this file has no
   *  reason to duplicate it just to move a refusal a few hundred milliseconds earlier for the one
   *  case (a syntactically valid but oversized range) this daemon-side check cannot catch anyway. */
  range: z.string().min(1).max(64).optional(),
  /** The one genuinely OPTIONAL operand (spec §2's own table only says `formulas?` — no default-
   *  on-invalid behavior is specified). Absent → `false` (values); this is the sole deliberate
   *  exception to "missing required operand is malformed." A PRESENT non-boolean is not silently
   *  coerced — `z.boolean().optional()` refuses it as malformed at the schema, the same as any
   *  other type mismatch this tool's args would produce. */
  formulas: z.boolean().optional(),
});
type SheetsArgs = z.infer<typeof SheetsArgs>;

/** A cheap SHAPE check only — "does this look like an A1 cell or a two-corner span," never real
 *  column math. One or two cell references (`[A-Za-z]+[1-9][0-9]*`) joined by exactly one colon. */
const A1_RANGE_SHAPE = /^[A-Za-z]+[1-9][0-9]*(:[A-Za-z]+[1-9][0-9]*)?$/;

// ================================================================================================
// The fence (spec §5 — narrower than write/edit's resolveWithinAny, on purpose)
// ================================================================================================

/**
 * PURE. Mirrors `officeAgentResolvedPathWithinFence`'s exact semantics (`OfficeAgentBroker.swift`),
 * not merely its message — the two independently-maintained fences must agree on every case, since a
 * daemon that dispatches a path the app then refuses (or vice versa) is a UX bug even though neither
 * side is technically wrong. A RELATIVE `path` resolves against `dirs[0]` (the primary), exactly as
 * `resolveWithinAny` resolves against `roots[0]`; an ABSOLUTE path is taken as-is. Containment is
 * checked against EVERY entry in `dirs`, not just the primary. `dirs` empty (no working-directory
 * concept, or genuinely none configured) refuses every path — mirrors `resolveWithinAny`'s own
 * `roots.length === 0` guard.
 *
 * Returns the resolved absolute path on success, `null` on refusal. Deliberately NOT symlink-hardened
 * the way `resolveWithinAny` is (`resolveLeafSymlinks`/`canonAncestor`) — same disclosed limitation
 * the Swift fence carries, acceptable for a backstop-shaped check behind the app's own broker fence,
 * not acceptable as this tool's ONLY gate (it isn't: the broker's fence runs again, independently,
 * app-side).
 */
function officeSheetsResolvedPathWithinFence(path: string, dirs: SessionDirs): string | null {
  if (dirs.length === 0) return null;
  const roots = dirs.map((d) => normalizePath(d.path));

  let target: string;
  if (path.startsWith("/")) {
    target = normalizePath(path);
  } else {
    const primary = roots[0];
    if (!primary) return null;
    target = normalizePath(`${primary}/${path}`);
  }

  for (const root of roots) {
    if (!root) continue;
    if (target === root || target.startsWith(`${root}/`)) return target;
  }
  return null;
}

/** Collapses `.`/`..`/duplicate slashes and drops a trailing slash — the Node equivalent of
 *  `NSString.standardizingPath`'s own normalization half (never the symlink-resolving half, which
 *  neither this function nor its Swift counterpart attempts — see this file's own header). */
function normalizePath(path: string): string {
  const isAbsolute = path.startsWith("/");
  const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") { if (stack.length > 0) stack.pop(); }
    else stack.push(part);
  }
  const joined = stack.join("/");
  return isAbsolute ? `/${joined}` : joined;
}

// ================================================================================================
// Reach (spec §3, mirroring browser.ts's panelReach — own wording, shared predicate)
// ================================================================================================

type OfficeReach = { ok: true } | { ok: false; reason: string };

function officeReach(deps: SheetsToolDeps, sessionId: string): OfficeReach {
  const attached = deps.harnesses(sessionId);
  const usable = attached.filter(canHostPanel);
  if (usable.length > 0) return { ok: true };
  if (attached.length === 0) {
    return {
      ok: false,
      reason: "office tools unavailable — the Mac app isn't showing this session, so nothing can "
        + "open the document (it may be closed, or open on a different session). Nothing was read.",
    };
  }
  const names = [...new Set(attached.map((h) => h.clientName))].sort().join(", ");
  return {
    ok: false,
    reason: `office tools unavailable — the Mac app isn't showing this session. The only clients `
      + `attached right now are: ${names} — a phone or a terminal cannot open a document. Nothing was read.`,
  };
}

// ================================================================================================
// The timeout wording Task 4 inherits (spec §4's durable contract)
// ================================================================================================

/** See this file's own header for why this is exported and why its wording never says "failed." */
export function officeTimeoutMessage(verbLabel: string, deadlineMs: number): string {
  return `the Mac app did not answer ${verbLabel} within ${Math.round(deadlineMs / 1000)}s. `
    + "The outcome is UNKNOWN, not a failure — the app may be busy, may have completed the verb and "
    + "lost the race home, or may be gone. Re-check before acting on this as if it failed: for a read, "
    + "simply try again; for anything that changes a document, NEVER retry blindly on a timeout alone "
    + "— re-read the document first to see whether the change already landed.";
}

// ================================================================================================
// Abort handling — a small, local copy of browser.ts's settleOrAbort/ABORTED (that file's own
// non-coupling posture: the two tools share a registry and a wire, nothing else).
// ================================================================================================

const ABORTED = Symbol("sheets-command-aborted");

async function settleOrAbort(
  settled: Promise<PanelCommandOutcome>,
  signal: AbortSignal | undefined,
): Promise<PanelCommandOutcome | typeof ABORTED> {
  if (!signal) return await settled;
  if (signal.aborted) return ABORTED;
  return await new Promise<PanelCommandOutcome | typeof ABORTED>((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then((outcome) => {
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    });
  });
}

// ================================================================================================
// Registration
// ================================================================================================

export interface SheetsToolDeps {
  /** `PanelCommandRegistry.dispatch` — identical contract `browser.ts`'s own deps document: the
   *  returned promise ALWAYS settles (result or timeout), never rejects. */
  dispatch(cmd: {
    sessionId: string;
    action: PanelCommandAction;
    args?: Record<string, unknown>;
    deadlineMs: number;
  }): { commandId: string; settled: Promise<PanelCommandOutcome> };
  /** `SessionHub.attachedHarnesses` — `browser.ts`'s own `BrowserToolDeps.harnesses`, the identical
   *  shape reused for the identical reach question. */
  harnesses(sessionId: string): ReadonlyArray<{ clientName: string; role?: string | null }>;
  /** The session's own raw working directories — `store.dirs(sessionId)`, never `ctx.roots`
   *  (`writableRoots`'s wider set, which also folds in `Edit(<path>)`-declared dirs and any
   *  dirGrant-adopted directory beyond the session's own `dirs` column). Deliberately the SAME
   *  narrower source `OfficeAgentBroker.Host.workingDirectories` reads app-side
   *  (`ShellSessionHost`'s `directory.rows...dirs`), so the two independently-maintained fences
   *  agree on what "this session's working directories" means. */
  dirsOf(sessionId: string): SessionDirs;
}

export function registerSheetsTool(r: ToolRegistry, deps: SheetsToolDeps): void {
  r.register({
    name: "sheets",
    description:
      "Read a spreadsheet Norma has access to (.xlsx, .ods, .xlsm — any format the office engine "
      + "can open). Pick a verb:\n"
      + "• info — path. Sheet names, each one's used range, and which sheet is active. Start here: "
      + "it also doubles as a check that the Mac app can actually open documents right now.\n"
      + "• read — path, sheet, range (A1 notation, e.g. \"A1:C10\" or a single cell \"B2\"), and an "
      + "optional formulas:true to get formula text instead of computed values. Returns a tab-"
      + "separated grid, row by row.\n"
      + "Every path must be inside this session's own working directories — an office read COPIES the "
      + "file and parses it with LibreOffice, so it is not an ordinary file read and the usual "
      + "unrestricted-reads rule does not cover it.\n"
      + "The Mac app has to be running and showing this session, or nothing here can work — info's own "
      + "refusal tells you if that's the problem.\n"
      + "A very large range is refused outright rather than silently truncated — ask for a smaller one.",
    modes: ["code", "dispatch"],
    args: SheetsArgs,
    async run(a: SheetsArgs, ctx) {
      const sessionId = ctx.sessionId;
      const action = `office.sheets.${a.verb}` as OfficeCommandAction;

      // Rung 1 — operands, per verb. `read` needs sheet+range; `info` needs neither beyond `path`
      // (already required by the schema for both verbs). Missing → malformed, never defaulted.
      if (a.verb === "read") {
        if (!a.sheet) {
          throw new Error('sheets read needs a `sheet` naming which sheet to read — e.g. verb:"read", '
            + 'path:"...", sheet:"Sheet1", range:"A1:C10".');
        }
        if (!a.range) {
          throw new Error('sheets read needs a `range` in A1 notation — e.g. range:"A1:C10" or a '
            + 'single cell range:"B2".');
        }
        if (!A1_RANGE_SHAPE.test(a.range)) {
          throw new Error(`"${a.range}" is not a valid A1 range — examples: "A1", "A1:C10". Sheet-`
            + "qualification (\"Sheet1!A1\") goes in the separate `sheet` operand, not in `range`.");
        }
      }

      // Rung 2 — the fence. Runs BEFORE reach (this file's own header explains why the ordering is
      // load-bearing, not incidental): a path that could never be allowed must refuse the same way
      // whether or not the app happens to be attached at this instant.
      const resolvedPath = officeSheetsResolvedPathWithinFence(a.path, deps.dirsOf(sessionId));
      if (!resolvedPath) {
        throw new Error(`path is outside the allowed directories: ${a.path}. Norma's office tools `
          + "are limited to the session's working directories.");
      }

      // Rung 3 — reach (the only TRANSIENT rung, checked last of the three, mirroring browser.ts's
      // own "permanent facts before transient ones" ladder).
      const reach = officeReach(deps, sessionId);
      if (!reach.ok) throw new Error(reach.reason);

      if (ctx.signal?.aborted) {
        return `sheets ${a.verb} was not sent — the turn was interrupted first.`;
      }

      const fields: Record<string, string | number | boolean> = {};
      if (a.verb === "read") {
        fields.sheet = a.sheet!;
        fields.range = a.range!;
        fields.formulas = a.formulas === true;
      }
      const args = officeCommandArgs(resolvedPath, Object.keys(fields).length > 0 ? fields : undefined);

      const deadlineMs = OFFICE_DEADLINES_MS[action];
      const { settled } = deps.dispatch({ sessionId, action, args, deadlineMs });

      const outcome = await settleOrAbort(settled, ctx.signal);

      if (outcome === ABORTED) {
        return `sheets ${a.verb} was interrupted before the Mac app answered.`;
      }

      if (outcome.kind === "timeout") {
        throw new Error(officeTimeoutMessage(`sheets ${a.verb}`, outcome.deadlineMs));
      }

      if (!outcome.ok) {
        throw new Error(outcome.result ?? `sheets ${a.verb} could not read ${a.path}`);
      }

      return outcome.result ?? `sheets ${a.verb} completed for ${a.path}`;
    },
  });
}
