import { z } from "zod";
import { realpathSync } from "node:fs";
import { resolveLeafSymlinks, canonicalizeForWrite } from "../paths";
import { OFFICE_DEADLINES_MS, officeCommandArgs, officeSheetsSetArgs, officeSheetsBatchArgs, officeBatchArgsTooLarge, OFFICE_BATCH_MAX_OPS, type OfficeCommandAction } from "../../panel/office-commands";
import type { ToolRegistry } from "./registry";
import type { PanelCommandAction, PanelCommandOutcome } from "../../panel/commands";
import type { SessionDirs } from "../../sessions/dirs";
import { canHostPanel } from "./browser";

/**
 * `sheets` (office-agent-tools T3/T4/T5, task-3-brief.md/task-4-brief.md/task-5-brief.md; design
 * `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §1-§5) — T3 shipped `info`/`read`;
 * T4 added the write verbs: `set`, `insert_rows`, `insert_cols`, `delete_rows`, `delete_cols`,
 * `add_sheet`, `delete_sheet`, `rename_sheet`. T5 adds the LAST verb this tool will ever register in
 * Stage C: `format` — `bold`/`italic`/`numberFormat`/`align`/`width` over an A1 range, every one
 * OPTIONAL and independent (an ABSENT key means "leave this attribute alone," never "reset it to a
 * default" — see `format`'s own rung in `run()` and its own description bullet below for the exact
 * contract). It drives the SAME `.uno:` commands a human formatting toolbar would send — see
 * `OfficeRuntime.sheetsFormat` (`apple/Norma/Sources/AppShell/OfficeRuntime.swift`) for the shared
 * app-side function a future human-facing formatting UI calls too, not a second path to LOK.
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
    "format",
    "batch",
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
  at: z.union([z.number().int().positive().max(9_999_999), z.string().min(1).max(8)]).optional(),
  /** `insert_rows`/`delete_rows`/`insert_cols`/`delete_cols` ONLY — how many rows/columns, starting
   *  at `at`. Capped at Calc's own row maximum (1,048,576 — more rows, and far more columns, than
   *  any sheet has), and `at` at 9,999,999, for the same reason `A1_RANGE_SHAPE`'s runs are bounded
   *  above: unbounded, these two reached a trapping `Int(Double)` conversion and an overflowing
   *  `at + count` in `OfficeCommandConsumer`, each of which ABORTED THE MAC APP. `1e30` satisfies
   *  `z.number().int().positive()` — `Number.isInteger(1e30)` is `true` — so "it is an integer" was
   *  never a bound at all. App-side guards are the load-bearing fix (T5 fix round, review
   *  Critical-1's sweep); these make the refusal immediate and specific. */
  count: z.number().int().positive().max(1_048_576).optional(),
  /** `add_sheet` (the NEW sheet's name) / `delete_sheet` (the EXISTING sheet to remove) /
   *  `rename_sheet` (the EXISTING sheet to rename) — never `insert_rows` and friends, which use
   *  `sheet` instead (see that field's own header for why the two verb families use different
   *  field names for "which sheet"). `add_sheet` always appends at the end — v1 does not support
   *  choosing a position; this tool's own description says so. */
  name: z.string().min(1).max(256).optional(),
  /** `rename_sheet` ONLY — the sheet's new name. */
  newName: z.string().min(1).max(256).optional(),
  /** `batch` ONLY — several sheet operations applied IN ORDER, in ONE call.
   *
   *  **Why this operand exists and the others do not compose into it.** `add_sheet`/`delete_sheet`/
   *  `rename_sheet` are the sheet verbs that are position/identity-based and non-idempotent, and
   *  building a workbook means several of them. Each as its own call pays a whole open+save cycle
   *  and its own enqueue behind the app's ONE app-wide `OfficeHelperRequestQueue`; all of them in
   *  one call pay that once.
   *
   *  **Bounded twice, both bounds computed rather than picked.** `OFFICE_BATCH_MAX_OPS` (20) is a
   *  TIME bound — the whole batch rides ONE helper request and therefore ONE 30 s request timeout —
   *  and is mirrored app-side in `OfficeWireBatchLimits.maxOperationsPerBatch`, the load-bearing
   *  copy. The serialized size is checked separately, before dispatch, against the same 8 KiB
   *  `panel_command.args` cap the wire enforces, so an over-size batch gets a sentence naming the
   *  real limit instead of the wire's opaque schema error.
   *
   *  Every element's own operands are the same ones the single verbs take, with the same rules: a
   *  `rename_sheet` element needs `newName`, and an `add_sheet`/`delete_sheet` element must not
   *  carry one. A malformed element refuses the WHOLE batch, naming that element's 1-based index —
   *  skipping it and reporting success is the silent-wrong-answer failure this tool's numeric
   *  guards exist to prevent. */
  ops: z.array(z.object({
    op: z.enum(["add_sheet", "delete_sheet", "rename_sheet"]),
    name: z.string().min(1).max(256),
    newName: z.string().min(1).max(256).optional(),
  })).min(1).max(OFFICE_BATCH_MAX_OPS).optional(),
  /** `format` ONLY — bold text on/off, an ABSOLUTE state (not a toggle): `true` makes the range
   *  bold regardless of its current state, `false` makes it explicitly not-bold, and — the operand
   *  this verb builds its whole contract on — LEAVING THIS KEY OUT of the call touches bold-ness not
   *  at all, on any cell in the range. Verified live, not assumed: applying `bold:true` twice in a
   *  row leaves the range bold both times (never flips back), and applying it to a range that starts
   *  with a MIX of bold and non-bold cells leaves every cell in it bold — see task-5-report.md. */
  bold: z.boolean().optional(),
  /** `format` ONLY — italic text on/off. Same absolute-state, same absent-means-untouched contract
   *  as `bold` above — see that field's own doc. */
  italic: z.boolean().optional(),
  /** `format` ONLY — a number-format PRESET, not an arbitrary format-code string (a disclosed,
   *  deliberate v1 narrowing from an earlier draft of this operand — not pre-approved, see
   *  task-5-report.md). "general" clears back to the plain default format; "number" is a decimal
   *  number (2 places); "percent"/"currency"/"date" apply that preset. Every preset changes how a
   *  cell's value DISPLAYS — NEVER the value itself: a cell holding the number 0.5, formatted
   *  "percent", reads back as the text "50.00%" from a `read` (both the exact string and the
   *  survival of a real close-and-reopen through the engine are asserted live), while any FORMULA
   *  elsewhere that references the cell still computes with the plain number 0.5 (`=D7*2` gives 1,
   *  not 100 — also asserted live). That split is the entire point of a number format.
   *
   *  **`read formulas:true` does NOT recover the raw value** — an earlier draft of this text told
   *  the model it did, and the T5 fix round's own drill measured otherwise: formulas mode on a
   *  formatted CONSTANT cell returns the same display string ("50.00%"), because there is no formula
   *  to show and the engine falls back to the formatted text. To get the underlying number, compute
   *  with it in a formula. Reapplying the SAME preset is a no-op, not a toggle back to
   *  general — this operand always sets an absolute state. Same absent-means-untouched contract as
   *  `bold` above. */
  numberFormat: z.enum(["general", "number", "percent", "currency", "date"]).optional(),
  /** `format` ONLY — horizontal text alignment. v1 has no vertical-alignment operand (not exposed,
   *  not planned for this pass). Same absent-means-untouched contract as `bold` above. */
  align: z.enum(["left", "center", "right"]).optional(),
  /** `format` ONLY — column width in POINTS (1/72 inch: an absolute, locale-independent physical
   *  unit, chosen because the underlying engine's own width dialog otherwise reports/accepts
   *  whatever measurement unit the human's own Tools>Options happens to be set to, which this tool
   *  has no way to know or rely on). **A COLUMN property, not a cell one, unlike every other operand
   *  on this verb**: `width` widens every column `range` touches, in FULL — e.g. range:"B2:B5" widens
   *  ALL of column B end to end, not just rows 2-5, because a spreadsheet has no notion of a
   *  partial-column width. Combining `width` with `bold`/`italic`/`numberFormat`/`align` in the same
   *  call is legal — the cell attributes apply to `range` exactly as given, `width` still applies to
   *  the full columns `range` spans, independently. Same absent-means-untouched contract as `bold`
   *  above (an absent `width` never resizes any column). Bounded to [1, 1000] points: the app-side
   *  conversion to the engine's own native unit (1/100mm) rounds a value below 1 point down to an
   *  unrepresentable zero — `.min(1)`, not `.positive()`, makes that impossible at the schema itself
   *  rather than relying on the app to clamp it; 1000 points (~13.9in) is well above any realistic
   *  column and keeps the converted value safely inside the engine's own uint16 argument. */
  width: z.number().min(1).max(1000).optional(),
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
 *  column math. One or two cell references (`[A-Za-z]{1,3}[1-9][0-9]{0,6}`) joined by exactly one
 *  colon.
 *
 *  **The letter/digit RUNS are bounded, and that is not cosmetic** (T5 fix round, review Critical-1).
 *  This pattern used to read `[A-Za-z]+[1-9][0-9]*` under a `.max(64)` — which accepted
 *  `"ZZZZZZZZZZZZZZ1"` and `"A1:B9223372036854775807"`, both of which then ABORTED THE MAC APP in
 *  the unchecked `Int` arithmetic of `officeColumnIndex`/`OfficeCellRange.cellCount`
 *  (`PanelDocumentTab.swift`). Those two functions are now total and are the LOAD-BEARING fix —
 *  this daemon-side bound is here so the model gets an immediate, specific refusal instead of a
 *  silent 155-second timeout, exactly the division of labour the `range` operand's own doc already
 *  describes. Deliberately still LEXICAL, and deliberately still looser than Calc's real grid: 3
 *  letters reaches XFE (one column past XFD) and 7 digits reaches 9,999,999 (past the 1,048,576-row
 *  maximum), so an out-of-grid reference remains expressible and is refused by the engine's own
 *  position verification — which is what `OfficeSheetsFormatTests`' position-verification drill
 *  rides. */
const A1_RANGE_SHAPE = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}(:[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/;

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
 * Returns the resolved absolute path on success, `null` on refusal.
 *
 * **SHARED by all three office tools** (`slides.ts` and `docs.ts` delegate to this one function).
 * It used to be three byte-identical copies — and three copies of a security fence, each needing the
 * identical hardening, is precisely how whole-branch review F4 would come back. One body now.
 *
 * **Symlink-hardened (whole-branch review F4, CRITICAL).** The prior text here called this
 * "deliberately NOT symlink-hardened … acceptable for a backstop-shaped check behind the app's own
 * broker fence", while the app's fence said the mirror image — acceptable behind *the daemon's* own
 * hardened check, `resolveWithinAny`. **Neither was true: no office tool has ever called
 * `resolveWithinAny`** (its only consumers are `engine.ts` and `fs-read.ts`), so each layer deferred
 * to a check the other never ran, and the same non-hardened string compare simply happened twice.
 * A working directory containing an ordinary `ln -s` pointing outside it let an agent `docs replace`
 * overwrite a file outside every declared root and report success.
 *
 * **Which layer is the gate:** the app's (`officeAgentResolvedPathWithinFence`,
 * `OfficeAgentBroker.swift`) — it runs in the process that performs the write, immediately before
 * open/edit/save, and the daemon is not the only possible caller. This copy is a fast pre-dispatch
 * refusal: better wording, no round trip, no app work started. It is hardened too, because a daemon
 * that dispatches a path the app then refuses is a UX bug even when neither side is wrong.
 *
 * **How.** Containment is judged on where the path really lands — `resolveLeafSymlinks` (which also
 * catches a DANGLING in-root link aimed outside, the task-24 hole) then `canonicalizeForWrite`
 * (realpath of the deepest existing ancestor with the missing tail re-appended). Roots are realpathed
 * where they exist and left verbatim where they do not. The RETURN value stays the caller's own
 * unresolved spelling — the contract `resolveWithinAny` documents, and load-bearing rather than
 * cosmetic: the app's broker matches `documents[resolvedPath]` to decide whether to ADOPT an already
 * open tab, so handing back a link-resolved spelling would silently open a second copy of a document
 * the user already has on screen.
 *
 * A path with nothing on disk resolves to itself, so a not-yet-created file is judged exactly as it
 * was before this fix — which is why every fictional-root case in the three tools' suites stays
 * meaningful. A symlink chain longer than `resolveLeafSymlinks`' own cap throws; that is caught here
 * and refused, fail-closed.
 */
export function officeResolvedPathWithinFence(path: string, dirs: SessionDirs): string | null {
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

  // F4. Fail-closed on a link cycle / over-long chain: resolveLeafSymlinks throws there, and a
  // fence that cannot determine where a path lands must refuse, never fall back to the spelling.
  let probe: string;
  try { probe = canonicalizeForWrite(resolveLeafSymlinks(target)); } catch { return null; }

  for (const root of roots) {
    if (!root) continue;
    // realpath where it exists, verbatim where it does not — a root with nothing on disk has no
    // symlink to resolve, and skipping it (resolveWithinAny's own behaviour) would turn a
    // not-yet-created working directory into a total refusal.
    let realRoot: string;
    try { realRoot = realpathSync(root); } catch { realRoot = root; }
    if (probe === realRoot || probe.startsWith(`${realRoot}/`)) return target;
  }
  return null;
}

/** Back-compat alias: this file's own call sites still read `officeSheetsResolvedPathWithinFence`. */
const officeSheetsResolvedPathWithinFence = officeResolvedPathWithinFence;

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
      + "engine can open). "
      + "**A write verb whose path does not exist CREATES the document** — there is no separate "
      + "\"create\" or \"new\" verb, exactly as with the `write` tool for ordinary files. The kind "
      + "comes from the EXTENSION, and it has to be one this tool handles (.xlsx or .ods for a spreadsheet); any missing "
      + "parent directories are created too. Two things to know: a `read` or `info` on a path that "
      + "does not exist still REFUSES (only writes create), and a create whose write then FAILS "
      + "usually leaves no file behind at all rather than an empty one — but not always (a "
      + "background save can land the empty document first), so check rather than assume. "
      + "Whenever a verb does create the document, its answer says so explicitly. "
      + "Every write verb SAVES immediately — there is no separate save step, and "
      + "you cannot undo from here. A HUMAN can: if they have the file open in a tab, one press of "
      + "⌘Z takes back your whole tool call, however many cells it changed, and ⌘⇧Z puts it back. "
      + "Before EVERY verb — `read` and `info` included — if a human already has that file open in a tab, Norma first SAVES whatever unsaved edits their tab is holding. So a read is NOT read-only with respect to disk: it flushes the human's own work to the file before reporting on it. (Nothing to flush when this tool opens the file itself.) The one exception is a file that ALSO changed on disk outside Norma while that tab held it: there are then two versions and Norma will not pick between them, so a read SKIPS that save and still answers from the tab's live content, and a write is REFUSED until the human answers the conflict banner in their tab. "
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
      + "edits the human never asked for, and THIS CALL leaves them unsaved — but the NEXT verb you "
      + "aim at that document, a plain read included, saves the tab before doing its own work, so "
      + "the partial write lands on the file then. It is not lost and it is not stuck: the human "
      + "takes the whole tool call back with one ⌘Z. What you must not do is treat a partial "
      + "failure as harmless because nothing was saved — say what was written, and to which cells, "
      + "so the human can decide; if this tool opened the document itself for this call, those "
      + "earlier cells are discarded, unsaved, the moment the call ends, and the next call starts "
      + "clean. The failure text states which of the two happened.\n"
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
      + "\u2022 batch \u2014 path, ops (a list of up to 20 operations, applied IN ORDER, in one "
      + "call). Use this whenever you need more than one of add_sheet/delete_sheet/rename_sheet \u2014 building a "
      + "workbook's sheet structure is the normal case. It is faster than separate calls because the whole batch "
      + "opens the document once, applies every operation, and saves once.\n"
      + "  Each operation is {op: \"add_sheet\"|\"delete_sheet\"|\"rename_sheet\", name, newName (rename_sheet only)}.\n"
      + "  WHAT A FAILED BATCH DOES, exactly: operations run in order and STOP at the first "
      + "failure. If any operation fails, NOTHING IS SAVED \u2014 the file on disk still holds its "
      + "previous contents, and the refusal tells you which operation failed, why, how many "
      + "applied before it, and which were never attempted. On disk a batch is all-or-nothing. "
      + "This never saves a partial batch to salvage it: a silent partial write you did not ask "
      + "for would be worse than a truthful refusal. One caveat you must act on: if a human "
      + "already had the file open in a tab, the operations that DID apply are sitting unsaved in "
      + "their tab, and \"all-or-nothing\" is true of THIS CALL only \u2014 the next verb you aim at "
      + "that file, a plain read included, saves the tab first, and the partial batch reaches the "
      + "file then. Tell the human what applied; one \u2318Z takes it back. The refusal says which "
      + "case you are in.\n"
      + "  Every operation that reports as applied was VERIFIED by re-reading the document \u2014 not "
      + "merely dispatched. A timeout is still OUTCOME UNKNOWN: because the batch saves once at the "
      + "end, either all of it reached the file or none of it did, so a single info call tells you "
      + "which. Never re-send a batch on a timeout without reading first \u2014 these operations are "
      + "position-based, so a blind resend can act on the wrong sheet entirely.\n"
      + "• format — path, sheet, range, and at least one of bold (boolean), italic (boolean), "
      + "numberFormat (\"general\"/\"number\"/\"percent\"/\"currency\"/\"date\" — a closed preset "
      + "set, not an arbitrary format code), align (\"left\"/\"center\"/\"right\"), width (column "
      + "width in points). An ABSENT key means \"leave this attribute alone\" — never \"reset it to "
      + "default\": format bold:true then, in a separate call, format italic:true on the same range, "
      + "and the bold from the first call survives. Every attribute sets an ABSOLUTE state, never a "
      + "toggle — true always makes bold/italic so, false always clears it, the same preset applied "
      + "twice is a no-op, not a flip-back. numberFormat changes how a cell's value DISPLAYS, never "
      + "the value itself — a cell holding 0.5 formatted \"percent\" reads back as \"50.00%\", while "
      + "any formula elsewhere referencing it still computes with the plain 0.5 (=D7*2 gives 1, not "
      + "100). formulas:true does NOT recover the raw value of a formatted constant cell — it "
      + "returns the same display string; compute with the cell in a formula instead. width is a "
      + "COLUMN property, not a cell one: it widens every "
      + "column range touches, in full, even if range is only a few rows tall — and because that is "
      + "a much larger operation than the range's cell count suggests, a call naming width is capped "
      + "at 256 columns (the cell attributes keep the full range). align is horizontal only in v1.\n"
      + "One honest limit on format's own answer: unlike set and the resize verbs, which re-read "
      + "what they changed, format reports the attributes it DISPATCHED and then saved. That is "
      + "strong evidence (a failed save is reported as a failure, and every attribute is proven live "
      + "against the saved bytes) but it is not a per-call read-back — if a specific cell's "
      + "formatting is load-bearing for what you do next, read it back yourself.\n"
      + "Every path must be inside this session's own working directories — an office read/write "
      + "COPIES the file and parses it with LibreOffice, so it is not an ordinary file read/write and "
      + "the usual unrestricted-reads rule does not cover it.\n"
      + "The Mac app has to be running and showing this session, or nothing here can work — info's own "
      + "refusal tells you if that's the problem.\n"
      + "A document a human has open with UNSAVED changes does NOT refuse a write any more — Norma saves their edits first and then writes. A write is refused only when that save FAILS (the refusal names what went wrong), or when the file also changed on disk outside Norma "
      + "and the human still has a conflict banner to answer.\n"
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
      + "since a retry can double the change if the first attempt actually landed. format is the one "
      + "exception worth naming: bold/italic/align/numberFormat/width all set an ABSOLUTE state, so "
      + "re-sending the exact same format call after a timeout is safe — it converges to the same "
      + "result, never doubles anything — but re-reading first is still the honest way to confirm "
      + "what actually happened before deciding to resend.",
    modes: ["code", "dispatch"],
    args: SheetsArgs,
    async run(a: SheetsArgs, ctx) {
      const sessionId = ctx.sessionId;
      const action = `office.sheets.${a.verb}` as OfficeCommandAction;
      const sheetVerbs = new Set(["read", "set", "insert_rows", "insert_cols", "delete_rows", "delete_cols", "format"]);
      const resizeVerbs = new Set(["insert_rows", "insert_cols", "delete_rows", "delete_cols"]);
      const rowVerbs = new Set(["insert_rows", "delete_rows"]);
      const rangeVerbs = new Set(["read", "set", "format"]);

      // Rung 1 — operands, per verb. Missing → malformed, never defaulted (this file's own
      // wire-strictness rule).
      if (sheetVerbs.has(a.verb) && !a.sheet) {
        throw new Error(`sheets ${a.verb} needs a \`sheet\` naming which sheet to act on — e.g. `
          + `verb:"${a.verb}", path:"...", sheet:"Sheet1", ...`);
      }
      if (rangeVerbs.has(a.verb)) {
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
      if (a.verb === "batch") {
        if (!a.ops || a.ops.length === 0) {
          throw new Error("sheets batch needs `ops` — a non-empty list of {op, name, newName?} "
            + "operations applied in order.");
        }
        // Per-element operand rules, refusing the WHOLE batch and naming the 1-based index. The zod
        // schema above cannot express these: it knows each element's field TYPES, not which fields a
        // given `op` requires or forbids — the same reason the single verbs' rules live in this
        // ladder rather than in the schema.
        for (let i = 0; i < a.ops.length; i++) {
          const o = a.ops[i]!;
          if (o.op === "rename_sheet" && !o.newName) {
            throw new Error(`sheets batch operation ${i + 1} is a rename_sheet and needs \`newName\` — `
              + "the sheet's new name.");
          }
          if (o.op !== "rename_sheet" && o.newName !== undefined) {
            throw new Error(`sheets batch operation ${i + 1} is a ${o.op} and must not carry `
              + "`newName` — only rename_sheet uses it.");
          }
        }
      }
      if (a.verb === "format") {
        if (a.bold === undefined && a.italic === undefined && a.numberFormat === undefined
            && a.align === undefined && a.width === undefined) {
          throw new Error("sheets format needs at least one of `bold`, `italic`, `numberFormat`, "
            + "`align`, `width` — an absent key means \"leave alone,\" so a call naming none of them "
            + "would do nothing.");
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
      } else if (a.verb === "batch") {
        args = officeSheetsBatchArgs(resolvedPath, a.ops!);
        const tooLarge = officeBatchArgsTooLarge(args, a.ops!.length);
        if (tooLarge) throw new Error(`sheets batch: ${tooLarge}`);
      } else if (a.verb === "format") {
        // Built conditionally, one key at a time — never `{ ..., bold: a.bold }` with `a.bold`
        // possibly `undefined` — so an omitted operand is OMITTED from the wire object entirely
        // (JSON has no way to say "this key is present but means nothing"; the absent-key contract
        // this verb's whole design rests on has to be enforced HERE, not hoped for downstream).
        const fields: Record<string, string | number | boolean> = { sheet: a.sheet!, range: a.range! };
        if (a.bold !== undefined) fields.bold = a.bold;
        if (a.italic !== undefined) fields.italic = a.italic;
        if (a.numberFormat !== undefined) fields.numberFormat = a.numberFormat;
        if (a.align !== undefined) fields.align = a.align;
        if (a.width !== undefined) fields.width = a.width;
        args = officeCommandArgs(resolvedPath, fields);
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
