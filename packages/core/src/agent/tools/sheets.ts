import { z } from "zod";
import { OFFICE_DEADLINES_MS, officeCommandArgs, officeSheetsSetArgs, type OfficeCommandAction } from "../../panel/office-commands";
import type { ToolRegistry } from "./registry";
import type { PanelCommandAction, PanelCommandOutcome } from "../../panel/commands";
import type { SessionDirs } from "../../sessions/dirs";
import { canHostPanel } from "./browser";

/**
 * `sheets` (office-agent-tools T3/T4, task-3-brief.md/task-4-brief.md; design
 * `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §1-§5) — T3 shipped `info`/`read`;
 * this task (T4) adds the write verbs: `set`, `insert_rows`, `insert_cols`, `delete_rows`,
 * `delete_cols`, `add_sheet`, `delete_sheet`, `rename_sheet`. `format` (T5+) is still not registered
 * — the model is never told about a verb this build cannot yet perform (contrast the app's own
 * `OfficeCommandConsumer`, which DOES answer all 22 for wire-completeness reasons that do not apply
 * to a tool schema no agent has reached yet).
 *
 * ## T4's own operand design — one real, disclosed deviation from the spec's compressed table
 *
 * Spec §2's table lists `set`'s operands as "path, sheet, range, values | formulas" — read as two
 * MUTUALLY EXCLUSIVE grid operands, one for literal values and one for formula text. This file ships
 * a SINGLE `values` operand instead: content, not a caller-declared mode, decides formula-ness —
 * exactly how every real spreadsheet already behaves (typing `=1+1` into a cell makes a formula
 * regardless of what the UI was "in mode for"; there is no separate "formula-entry mode" a human
 * ever toggles). Three reasons, not just simplicity for its own sake: (1) `read`'s own `formulas`
 * operand is already a `boolean` — a second, differently-typed `formulas` grid operand on the SAME
 * flat zod object would collide, forcing an awkward rename either way; (2) the write mechanism this
 * task builds (real synthetic text entry into a cell, on the agent view — see the app/helper side)
 * has no separate code path for "type as a formula" vs "type as a value" — LOK/Calc's own cell-edit
 * parser is what decides, from the leading character, exactly as it does for a human; (3) a model
 * that wants a LITERAL string starting with `=` gets the identical escape hatch a human has: prefix
 * it with an apostrophe (`'`), documented in this tool's own description below and applied
 * automatically by the app for exactly that one case (see `OfficeCommandConsumer`'s own header).
 * Verified live, not merely reasoned — see task-4-report.md for the drill.
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
  verb: z.enum([
    "info", "read", "set",
    "insert_rows", "insert_cols", "delete_rows", "delete_cols",
    "add_sheet", "delete_sheet", "rename_sheet",
  ]),
  /** Absolute (or, mirroring `resolveWithinAny`, resolved against the session's primary working
   *  directory if relative) — spec §2's own table. Required for EVERY verb; a missing path is
   *  malformed, never defaulted (this file's own wire-strictness rule, matching the Swift broker's
   *  identical posture for the same operand). */
  path: z.string().min(1).max(4096),
  /** The sheet NAME (never an index): resolved to a part index app-side, where `getPartName` lives
   *  (`OfficeWireFrame.sheetsRead`'s own header explains why that resolution cannot happen here).
   *  Required for `read`/`set`/`insert_rows`/`insert_cols`/`delete_rows`/`delete_cols` — the six
   *  verbs that act ON a sheet's own rows/columns/cells. NOT used by `add_sheet`/`delete_sheet`/
   *  `rename_sheet`, which name the sheet they act on through `name` instead (a NEW sheet has no
   *  existing `sheet` to name, and a delete/rename's target IS `name` — a second `sheet` operand
   *  would just be a confusing, always-redundant alias for it). */
  sheet: z.string().min(1).max(512).optional(),
  /** An A1 range: a single cell ("A1") or a two-corner span ("A1:C10"). `read`/`set` only. Validated
   *  SYNTACTICALLY here (a cheap regex, catching an obviously malformed string before a round trip)
   *  — the real A1 SEMANTICS (letters<->column math) and the cell-count CAP live app-side
   *  (`PanelDocumentTab.swift`'s `officeParseRange`/`officeReadRangeMaxCells`), deliberately not
   *  reimplemented here: Stage B T8 built that conversion once, in Swift, and this file has no
   *  reason to duplicate it just to move a refusal a few hundred milliseconds earlier for the one
   *  case (a syntactically valid but oversized range) this daemon-side check cannot catch anyway. */
  range: z.string().min(1).max(64).optional(),
  /** `read` ONLY — whether to return formula text instead of computed values. The one genuinely
   *  OPTIONAL operand on `read` (spec §2's own table only says `formulas?` — no default-on-invalid
   *  behavior is specified). Absent → `false` (values); this is the sole deliberate exception, ON
   *  READ, to "missing required operand is malformed." A PRESENT non-boolean is not silently
   *  coerced — `z.boolean().optional()` refuses it as malformed at the schema, the same as any
   *  other type mismatch this tool's args would produce.
   *
   *  **`set` does NOT have a `formulas` operand** — see this file's own header for why a single
   *  `values` grid (content-driven formula detection, exactly like a real spreadsheet) replaces the
   *  spec table's compressed "values | formulas" notation. This field name is reused ONLY by `read`. */
  formulas: z.boolean().optional(),
  /** `set` ONLY — a rectangular, row-major grid of cell content. Each cell is a plain value
   *  (string/number/boolean, JSON-typed so a model does not have to stringify a number itself) —
   *  see this file's own header for how formula-ness is decided from a leading `=`, and how a
   *  LITERAL leading `=` is escaped (a leading apostrophe, applied automatically app-side).
   *  Non-empty, and every row must be the SAME length (a ragged grid is malformed, never padded) —
   *  checked here; the grid's own dimensions must also match `range`'s real cell dimensions exactly
   *  (Calc's own paste/fill behavior on a size MISMATCH is not something this tool relies on), which
   *  — like every other real A1 computation — is an app-side check (`OfficeCommandConsumer`'s own
   *  validation, before the broker or LOK is ever reached). Capped at `sheetsSetMaxCells` (below) —
   *  smaller than `read`'s 2,000-cell cap, deliberately: each written cell costs a real per-cell LOK
   *  round trip (select, verify, type), not one bulk read, so the safe ceiling is much lower. */
  values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()])).min(1)).min(1).optional(),
  /** `insert_rows`/`delete_rows`/`insert_cols`/`delete_cols` ONLY — WHERE the operation starts.
   *  Rows: a 1-based row number (matching A1 notation's own 1-based rows) as either a JSON number or
   *  a decimal string — either is accepted at the SCHEMA level; the per-verb rung below is what
   *  actually enforces which shape a given verb needs and refuses the other cleanly. Columns: one or
   *  more letters ("C", "AA"), matching this tool's A1-first design everywhere else (`range` never
   *  exposes raw column integers to a caller — Task 3's own deliberate choice, carried forward here
   *  rather than introducing the ONE place in this tool that would). */
  at: z.union([z.number().int().positive(), z.string().min(1).max(8)]).optional(),
  /** `insert_rows`/`delete_rows`/`insert_cols`/`delete_cols` ONLY — how many rows/columns, starting
   *  at `at`. */
  count: z.number().int().positive().optional(),
  /** `add_sheet` (the NEW sheet's name) / `delete_sheet` (the EXISTING sheet to remove) /
   *  `rename_sheet` (the EXISTING sheet to rename) — never `insert_rows` and friends, which use
   *  `sheet` instead (see that field's own header for why the two verb families use different
   *  field names for "which sheet"). `add_sheet` always appends at the end — v1 does not support
   *  choosing a position; this tool's own description says so. */
  name: z.string().min(1).max(256).optional(),
  /** `rename_sheet` ONLY — the sheet's new name. */
  newName: z.string().min(1).max(256).optional(),
});
type SheetsArgs = z.infer<typeof SheetsArgs>;

/** `set`'s own cell-count ceiling — see `values`'s own doc comment for why this is smaller than
 *  `read`'s `officeReadRangeMaxCells` (2,000): each cell this tool writes costs a real per-cell LOK
 *  round trip inside the app's single dedicated-thread request (select, verify the selection landed,
 *  type, on the agent view — see `OfficeCommandConsumer`/`LOKBridge`'s own headers), not one bulk
 *  probe the way a read is. 200 comfortably covers a small table or a handful of formulas — the
 *  ordinary `set` call — while keeping one call's own worst-case latency and `panel_command.args`
 *  wire footprint (8 KiB total, `PANEL_COMMAND_ARGS_MAX_JSON_BYTES`) bounded. Checked here, before
 *  dispatch, for the identical reason `read`'s own cap is checked before dispatch: refuse cheaply
 *  rather than pay for a doomed round trip. */
const sheetsSetMaxCells = 200;

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
      "Read and edit a spreadsheet Norma has access to (.xlsx, .ods, .xlsm — any format the office "
      + "engine can open). Every write verb SAVES immediately — there is no separate save step, and "
      + "no undo from here (the file changes right away; a human's ⌘Z in an open tab is unaffected). "
      + "Pick a verb:\n"
      + "• info — path. Sheet names, each one's used range, and which sheet is active. Start here: "
      + "it also doubles as a check that the Mac app can actually open documents right now.\n"
      + "• read — path, sheet, range (A1 notation, e.g. \"A1:C10\" or a single cell \"B2\"), and an "
      + "optional formulas:true to get formula text instead of computed values. Returns a tab-"
      + "separated grid, row by row.\n"
      + "• set — path, sheet, range, values (a rectangular grid of strings/numbers/booleans, same "
      + "shape and dimensions as range). A cell starting with \"=\" becomes a formula, exactly like "
      + "typing it into the cell yourself — to write a LITERAL string that starts with \"=\", prefix "
      + "it with an apostrophe (e.g. \"'=NOT A FORMULA\"). The SAME escape applies if the literal "
      + "content you want should itself start with an apostrophe — prefix it with a SECOND one (e.g. "
      + "\"''twas the night\" writes the cell as \"'twas the night\"; the first apostrophe is always "
      + "consumed as the force-text marker, never stored). An empty string (\"\") CLEARS a cell's "
      + "existing content — this is the only way to clear a cell; there is no separate delete/clear "
      + "operand. No cell may contain a tab, carriage return, or newline — write to one cell at a "
      + "time for that content instead. values' own dimensions must exactly match range's. **set "
      + "writes cells in order and is NOT atomic**: if a later cell in the same call fails (e.g. an "
      + "unwritable formula character), earlier cells in that same call have already been written but "
      + "NOT saved — writing only ever changes the document's own in-memory state; saving is a "
      + "separate step this tool always tries afterward, and it never runs after a mid-call failure. "
      + "What happens to those unsaved earlier cells depends on whether the document was already open "
      + "in the human's own tab when this call started: if it was, that tab is now left dirty with "
      + "edits the human never asked for, and EVERY later write to that same document will be refused "
      + "until the human saves or discards it themselves — re-reading and retrying does not recover "
      + "from this, only the human can; if this tool opened the document itself for this call, those "
      + "earlier cells are discarded, unsaved, the moment the call ends, and the next call starts "
      + "clean. The failure text states which of the two happened. This never auto-saves a partial "
      + "write to dodge this — a silent partial save the human never asked for would be worse than "
      + "the refusal above.\n"
      + "• insert_rows / delete_rows — path, sheet, at (1-based row number), count (how many rows). "
      + "insert_rows adds count new blank rows starting AT that row number, shifting existing rows "
      + "down; delete_rows removes count rows starting there.\n"
      + "• insert_cols / delete_cols — path, sheet, at (column letters, e.g. \"C\"), count (how many "
      + "columns), same shifting/removal semantics as the row verbs.\n"
      + "• add_sheet — path, name. Appends a new, empty sheet at the end (v1 has no way to choose a "
      + "position). Confirmed live: does NOT change which sheet is active in a document a human "
      + "already has open.\n"
      + "• delete_sheet — path, name. Refused if it would delete the workbook's LAST sheet. Confirmed "
      + "live: deleting a sheet OTHER than the active one does not change which sheet is active.\n"
      + "• rename_sheet — path, name (the sheet to rename), newName. Can change which sheet is shown "
      + "as ACTIVE in a document a human already has open — a real, visible side effect on that tab "
      + "(a timing-dependent one, not guaranteed on every call).\n"
      + "Every path must be inside this session's own working directories — an office read/write "
      + "COPIES the file and parses it with LibreOffice, so it is not an ordinary file read/write and "
      + "the usual unrestricted-reads rule does not cover it.\n"
      + "The Mac app has to be running and showing this session, or nothing here can work — info's own "
      + "refusal tells you if that's the problem.\n"
      + "A document a human has open with UNSAVED changes refuses every write, naming the tab — save "
      + "or discard those edits first.\n"
      + "A very large range/grid is refused outright rather than silently truncated — ask for a "
      + "smaller one.\n"
      + "read's grid is trimmed to the range's REAL content, not padded to the requested rectangle — "
      + "a range whose only real content sits away from its top-left corner comes back without "
      + "leading blank rows/columns, so a value's position in the returned grid does not necessarily "
      + "match its real cell position. For precise positioning, request a tightly-scoped range (a "
      + "single cell or a range you already know is fully populated) rather than relying on padding.\n"
      + "A cell whose own content contains a tab or a literal \" is wrapped in \"...\" with internal "
      + "\" doubled (the same convention CSV/TSV files use) so it can't be confused with a real "
      + "column boundary — that quoting is an ENCODING, not part of the cell's real value: "
      + "say \"hi\" round-trips as \"say \"\"hi\"\"\", not as the literal text between the quotes.\n"
      + "**A timeout means the outcome is UNKNOWN, never that a write failed to happen** — the app "
      + "may have completed it and lost the race home. Re-read the document before ever retrying a "
      + "write verb; never blind-retry set/insert_rows/insert_cols/add_sheet/etc. on a timeout alone, "
      + "since a retry can double the change if the first attempt actually landed.",
    modes: ["code", "dispatch"],
    args: SheetsArgs,
    async run(a: SheetsArgs, ctx) {
      const sessionId = ctx.sessionId;
      const action = `office.sheets.${a.verb}` as OfficeCommandAction;
      const sheetVerbs = new Set(["read", "set", "insert_rows", "insert_cols", "delete_rows", "delete_cols"]);
      const resizeVerbs = new Set(["insert_rows", "insert_cols", "delete_rows", "delete_cols"]);
      const rowVerbs = new Set(["insert_rows", "delete_rows"]);

      // Rung 1 — operands, per verb. Missing → malformed, never defaulted (this file's own
      // wire-strictness rule).
      if (sheetVerbs.has(a.verb) && !a.sheet) {
        throw new Error(`sheets ${a.verb} needs a \`sheet\` naming which sheet to act on — e.g. `
          + `verb:"${a.verb}", path:"...", sheet:"Sheet1", ...`);
      }
      if ((a.verb === "read" || a.verb === "set")) {
        if (!a.range) {
          throw new Error(`sheets ${a.verb} needs a \`range\` in A1 notation — e.g. range:"A1:C10" `
            + 'or a single cell range:"B2".');
        }
        if (!A1_RANGE_SHAPE.test(a.range)) {
          throw new Error(`"${a.range}" is not a valid A1 range — examples: "A1", "A1:C10". Sheet-`
            + "qualification (\"Sheet1!A1\") goes in the separate `sheet` operand, not in `range`.");
        }
      }
      if (a.verb === "set") {
        if (!a.values) {
          throw new Error('sheets set needs `values` — a rectangular grid, e.g. values:[["A","B"],'
            + '["1","2"]]. See this tool\'s own description for how "=" is handled.');
        }
        const width = a.values[0]?.length ?? 0;
        for (const row of a.values) {
          if (row.length !== width) {
            throw new Error("sheets set's `values` must be a RECTANGULAR grid — every row must have "
              + `the same number of cells (row 1 has ${width}, another row has ${row.length}).`);
          }
          for (const cell of row) {
            if (typeof cell === "string" && /[\t\r\n]/.test(cell)) {
              throw new Error("sheets set's `values` cells may not contain a tab, carriage return, "
                + "or newline — write to one cell at a time for that content instead.");
            }
          }
        }
        const cellCount = a.values.length * width;
        if (cellCount > sheetsSetMaxCells) {
          throw new Error(`values spans ${cellCount} cells, past the ${sheetsSetMaxCells}-cell limit `
            + "on one set call — write a smaller grid, or split it across multiple calls.");
        }
      }
      if (resizeVerbs.has(a.verb)) {
        if (a.at === undefined) {
          throw new Error(`sheets ${a.verb} needs \`at\` — ${rowVerbs.has(a.verb)
            ? "a 1-based row number (e.g. at:3)" : 'column letters (e.g. at:"C")'}.`);
        }
        if (!a.count) {
          throw new Error(`sheets ${a.verb} needs a positive \`count\` — how many `
            + `${rowVerbs.has(a.verb) ? "rows" : "columns"} (e.g. count:2).`);
        }
        if (rowVerbs.has(a.verb)) {
          const asString = String(a.at);
          if (!/^[1-9][0-9]*$/.test(asString)) {
            throw new Error(`sheets ${a.verb}'s \`at\` must be a positive 1-based row number `
              + `(matching A1 notation's own row numbering) — got: ${JSON.stringify(a.at)}.`);
          }
        } else {
          if (typeof a.at !== "string" || !/^[A-Za-z]+$/.test(a.at)) {
            throw new Error(`sheets ${a.verb}'s \`at\` must be column letters (e.g. "C", "AA") — `
              + `got: ${JSON.stringify(a.at)}.`);
          }
        }
      }
      if (a.verb === "add_sheet" && !a.name) {
        throw new Error('sheets add_sheet needs a `name` for the new sheet — e.g. name:"Q3".');
      }
      if (a.verb === "delete_sheet" && !a.name) {
        throw new Error('sheets delete_sheet needs `name` — which sheet to delete.');
      }
      if (a.verb === "rename_sheet") {
        if (!a.name) {
          throw new Error('sheets rename_sheet needs `name` — the EXISTING sheet to rename.');
        }
        if (!a.newName) {
          throw new Error('sheets rename_sheet needs `newName` — the sheet\'s new name.');
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

      let args: Record<string, unknown>;
      if (a.verb === "read") {
        args = officeCommandArgs(resolvedPath, { sheet: a.sheet!, range: a.range!, formulas: a.formulas === true });
      } else if (a.verb === "set") {
        args = officeSheetsSetArgs(resolvedPath, a.sheet!, a.range!, a.values!);
      } else if (resizeVerbs.has(a.verb)) {
        args = officeCommandArgs(resolvedPath, { sheet: a.sheet!, at: a.at!, count: a.count! });
      } else if (a.verb === "add_sheet") {
        args = officeCommandArgs(resolvedPath, { name: a.name! });
      } else if (a.verb === "delete_sheet") {
        args = officeCommandArgs(resolvedPath, { name: a.name! });
      } else if (a.verb === "rename_sheet") {
        args = officeCommandArgs(resolvedPath, { name: a.name!, newName: a.newName! });
      } else {
        args = officeCommandArgs(resolvedPath);
      }

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
        throw new Error(outcome.result ?? `sheets ${a.verb} could not be completed for ${a.path}`);
      }

      return outcome.result ?? `sheets ${a.verb} completed for ${a.path}`;
    },
  });
}
