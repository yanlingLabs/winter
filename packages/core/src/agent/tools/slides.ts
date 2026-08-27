import { z } from "zod";
import { OFFICE_DEADLINES_MS, officeCommandArgs, officeSlidesBatchArgs, officeBatchArgsTooLarge, OFFICE_BATCH_MAX_OPS, type OfficeCommandAction } from "../../panel/office-commands";
import type { ToolRegistry } from "./registry";
import type { PanelCommandAction, PanelCommandOutcome } from "../../panel/commands";
import type { SessionDirs } from "../../sessions/dirs";
import { canHostPanel } from "./browser";
import { officeTimeoutMessage, officeResolvedPathWithinFence } from "./sheets";

/**
 * `slides` (office-agent-tools T6, task-6-brief.md; design
 * `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §2 (`slides` table), §3, §4, §5) —
 * the agent's vocabulary for presentations, the SAME `panel_command` bridge `sheets` already proved
 * (T1-T5) driving LibreOfficeKit's Impress engine instead of Calc. Verbs: `info` (slide count, each
 * slide's own name AND title — also the drivability probe, spec §1/§3), `read` (a slide's placeholder
 * text), `set_text` (title and/or body), `add_slide` (optional position/layout), `delete_slide`,
 * `reorder`.
 *
 * ## Four controller rulings, post-implementation, from `slides-lok-research.md` (2026-08-24) — the
 * authority this file now follows, superseding this header's own earlier text where they conflict
 *
 * A dedicated research pass into the pinned LibreOffice source (commit `11482c8f71bc76ed6260bc03b1576a52a788ab4f`)
 * found real, cited answers this task's first pass had to leave as open placeholders. Four rulings
 * follow from it, adjudicated by the controller, not re-litigated here:
 *
 * 1. **`layout` is WRITE-ONLY.** `getPartInfo` (the only per-slide JSON LOK exposes) carries no
 *    layout field at either of its two emission sites, and no `getCommandValues` query exposes one
 *    either — LOK gives NO layout read-back, for any slide, ever. `add_slide`'s own `layout` operand
 *    still *sets* one; `info` reports none, structurally, not by this tool's own choice to omit it.
 * 2. **`info` reports `name` AND `title`; every verb targets BY INDEX ONLY, never by `name`.**
 *    `getPartName` is NOT a title — for a never-renamed slide it is recomputed POSITIONALLY
 *    ("Slide N") on every call, live, from the slide's current position. A model reading `name` and
 *    mistaking it for a stable title would misidentify a slide the instant a `reorder` lands.
 * 3. **`reorder` — PROBED, then KEPT (controller-adjudicated, 2026-08-24).** No arbitrary-index move
 *    command exists in this engine at all — only selection-based `MovePageUp`/`Down`/`First`/`Last` —
 *    so reachability from a headless LOK session (one that never shows a Slide Sorter panel) was
 *    undetermined from source alone and had to be probed live before any production dispatch code was
 *    written for it (`OfficeSlidesCommandTests.testProbeInvestigatesWhetherReorderIsReachableHeadless`).
 *    Verdict: reachable — `setPart` DOES drive `MovePage*`'s own selection-based targeting, confirmed
 *    by a three-position content readout, not by `getPartName` (see ruling 2 above for why that would
 *    have been a trap). The PROBE itself (this ruling's own subject) used content-based verification,
 *    not `getPartInfo`'s `hash` field, despite hash being the controller's own original instruction —
 *    a disclosed substitution, approved at the time: neither of LOK's two in-session identity
 *    primitives survives save+reload, which the mandatory two-part-discriminator proof (save+reopen)
 *    every write verb here needs regardless, so content-based verification served both the probe and
 *    the eventual proof with one mechanism. **Fix round 1 (F-5/F-6, `task-6-report.md` §8) reconciled
 *    the original instruction and the substitution instead of picking one**: content-based
 *    verification let `add_slide`/`reorder` false-pass on empty or duplicate titles (`add_slide`
 *    itself mints empty-titled slides), so the in-session write-verification loop for all three
 *    structural verbs (`add_slide`/`delete_slide`/`reorder`) now runs on `hash` after all — genuine
 *    per-object identity, immune to the title-collision class. Content-based verification still does
 *    the one job hash structurally cannot: the save+reopen two-part-discriminator proof, since neither
 *    primitive survives reload. Two mechanisms, two jobs now, not one mechanism serving both.
 *    `reorder`'s own real mechanism
 *    dispatches on the PRIMARY view (not the agent-view isolation every other write verb in this file
 *    uses) — borrowed from `sheetsManageSheetOnDedicatedThread`'s own two-round live history of
 *    agent-view structural dispatch hanging or failing to converge; see that function's own header and
 *    `LOKBridge.slidesReorderOnDedicatedThread`'s. Carries the same disclosed residual sheets' own
 *    `rename_sheet` has: can change which slide is shown ACTIVE in an already-open human tab (see this
 *    verb's own tool-description line below).
 * 4. **Three commands are BANNED BY NAME**, never dispatched even to experiment:
 *    `.uno:RenamePage`/`RenameMasterPage` (opens a blocking modal dialog on this bridge's one
 *    dedicated LOK thread — wedges every open office document until the app restarts, since nothing
 *    kills a request on timeout, only on the process actually dying); `.uno:ModifyPage` (0/1/2 args
 *    silently no-ops, a well-formed 4-arg call with a wrong-typed item is a RELEASE-BUILD crash —
 *    `.uno:AssignLayout` sidesteps this entirely, see `LOKBridge.slidesManagePageOnDedicatedThread`'s
 *    own header); and the phantom `InsertSlide`/`DeleteSlide`/`RenameSlide`/`MoveSlide*` menu ids that
 *    appear verbatim in this repo's own vendored `simpress/popupmenu/page.xml` but have NO backing SFX
 *    slot anywhere in the engine — presence in shipped UI config is not proof of dispatchability.
 *
 * ## Inherited wholesale from `sheets.ts`, not reinvented — the brief's own instruction
 *
 * The fence (`officeSlidesResolvedPathWithinFence`, below — mirrors `officeSheetsResolvedPathWithinFence`'s
 * exact semantics, duplicated rather than imported for the SAME reason `sheets.ts`'s own header gives
 * for not importing `browser.ts`'s `panelReach`: this tool and `sheets` answer through the identical
 * bridge but have nothing else to say to each other), `officeReach` (same duplication reasoning,
 * reusing the exported `canHostPanel` predicate), the abort handling, and the whole `run()` shape
 * (rungs: per-verb operand validation -> fence -> reach -> dispatch -> settle) are copy-adapted from
 * `sheets.ts`, not re-derived. `officeTimeoutMessage` is the ONE piece actually IMPORTED rather than
 * duplicated: it is fully generic (parameterized by `verbLabel`), exported by `sheets.ts` specifically
 * so every office tool says the identical OUTCOME-UNKNOWN sentence (spec §4's durable contract) —
 * duplicating its wording here would risk the two texts drifting apart over time, the one thing that
 * function exists to prevent. (A disclosed, minor architectural choice: importing a sibling tool
 * FILE's export is slightly unusual for this bridge's own "own wording, not shared" posture elsewhere
 * — moving it to `office-commands.ts`, the file already explicitly documented as "what every tool
 * needs in common," would be cleaner, but that touches `sheets.ts`'s own already-shipped, reviewed
 * surface for a one-line reason; left as a note for a future pass rather than done here.)
 *
 * ## Slides are LOK *parts* — the trap this task exists to get right (task-6-brief.md's own words)
 *
 * Every write verb must carry and set the correct part under the established discipline (`setView`
 * prefix, type-gated `setPart`, no queue nesting — spec §3 step 3), and the app-side proof for EVERY
 * write verb is the two-part discriminator: slide N changed, slide M did not, through save+reopen —
 * see `OfficeSlidesCommandTests.swift` for where that actually lives (this file only shapes and
 * dispatches the wire call; the mechanism and its proof are entirely app/helper-side).
 *
 * ## 1-based indexing, everywhere
 *
 * `slide`/`at`/`to` are all 1-based (matching how a human counts slides, and matching `sheets`' own
 * 1-based row numbering) — never a raw 0-based LOK part index, which the app alone translates.
 *
 * ## `info`'s `name` vs `title` — spec §2 said "titles, layout names"; ruling 1+2 correct both nouns
 *
 * Spec §2's compressed table says `info` returns "slide count, titles, layout names." Research
 * settled both: `info` returns `name` (positional/rename-fallback, `getPartName`) AND `title`
 * (real placeholder text, when one exists) as two DISTINCT fields — never just "titles" — and no
 * layout at all, ever (ruling 1). `read` remains the dedicated placeholder-text verb for a SINGLE
 * slide; `info` now pays the same per-slide text-read cost for every slide's title in one call
 * (unavoidable once `title` had to be real, not a name-shaped stand-in for it) — a real cost increase
 * from the tool's original "cheap like `browser tabs`" design goal, disclosed here rather than
 * silently absorbed.
 */

// ================================================================================================
// Operands
// ================================================================================================

/** office-agent-tools T6 — `add_slide`'s own `layout` preset. WRITE-ONLY (ruling 1: `info` never
 *  reports one back — LOK has no read-back for it at all). A CLOSED enum, not a free-form layout name
 *  or LOK's raw 35-value internal `AutoLayout` id — the identical posture `sheets format`'s
 *  `numberFormat` ships (task-5-report.md §2's own precedent, ratified by the coordinator): a wrong
 *  numeric id silently no-ops or misapplies rather than refusing. These 16 are not invented — they are
 *  the exact UI-exposed subset `slides-lok-research.md` §4 cites to the vendored product's own
 *  `simpress/popupmenu/page.xml` `SlideLayoutMenu` block (the same layouts a human sees in Impress's
 *  own layout picker), applied via `.uno:AssignLayout`'s `WhatLayout` argument
 *  (`OfficeSlidesLayoutPreset.autoLayoutValue` on the Swift side carries the exact integer each name
 *  maps to — raw string values here MUST match that enum's `rawValue`s byte-for-byte, a wire string
 *  decoded independently on both ends). */
const SlidesLayoutPreset = z.enum([
  "title_slide", "title_content", "title_two_content", "title_content_two_content",
  "title_content_over_content", "title_two_content_content", "title_two_content_over_content",
  "title_four_content", "title_only", "blank",
  "vertical_title_vertical_content_over_vertical_content", "vertical_title_vertical_content",
  "title_vertical_content", "title_two_vertical_content", "centered_text", "title_six_content",
]);
export type SlidesLayoutPreset = z.infer<typeof SlidesLayoutPreset>;

/** `format`'s alignment — the same four values `docs format` takes, and the same argument-free,
 *  zero-hazard dedicated slots underneath.
 *
 *  ⚠️ **On a slide, aligning a placeholder's text also RE-ANCHORS the text box itself.** That is a
 *  whole-shape effect Writer has no analogue for; it is disclosed in the description and in the
 *  verb's own result sentence, not smuggled. */
const SlidesAlign = z.enum(["left", "center", "right", "justify"]);

/** `format`'s line spacing — **THREE values, not the four `docs format` offers. `1.15` is missing
 *  because LibreOffice's presentation editor does not have it**: it binds slots for single, 1.5 and
 *  double and none for 1.15.
 *
 *  This is a SEPARATE enum from `docs.ts`'s deliberately, all the way down through the Swift wire.
 *  A shared four-value enum would let a model ask a slide for a spacing the engine cannot apply, and
 *  the failure would be a silent no-op — the exact shape this arc keeps shipping. Refused here, and
 *  refused again app-side with a sentence that explains it is a real difference between the two
 *  editors rather than a Norma limitation. */
const SlidesLineSpacing = z.enum(["single", "1.5", "double"]);

/** Which of a slide's two addressable text areas to format — the same pair `read`/`set_text`
 *  already address, with the same Tab-order caveat those verbs carry. */
const SlidesPlaceholder = z.enum(["title", "body"]);

const SlidesArgs = z.object({
  verb: z.enum(["info", "read", "set_text", "add_slide", "delete_slide", "reorder", "batch", "format"]),
  /** Absolute (or resolved against the session's primary working directory if relative) — spec §2's
   *  own table. Required for EVERY verb; a missing path is malformed, never defaulted — matches
   *  `sheets.ts`'s identical wire-strictness rule for the same operand. */
  path: z.string().min(1).max(4096),
  /** The 1-based slide number this verb acts on. Required for `read`/`set_text`/`delete_slide`/
   *  `reorder` — the four verbs that target ONE already-existing slide. NOT used by `info` (whole-
   *  document) or `add_slide` (which has no existing slide to name — see `at` below for where a NEW
   *  slide lands).
   *
   *  **Bounded (T5 fix round, re-review's NEW Critical).** `z.number().int().positive()` is not a
   *  bound: `Number.isInteger(1e30)` is `true`, so `1e30` satisfied every clause and reached the
   *  app's own `OfficeCommandConsumer.oneBasedIndex`, whose `Int(Double)` TRAPS outside `Int`'s
   *  range — aborting Norma.app and every open document's unsaved edits, from `slides read
   *  slide:1e30`. Identical class to `sheets`' own `at`/`count`, on five live handlers. The
   *  app-side ceiling is the load-bearing fix (`officeSlideMaxIndex`); this makes the refusal
   *  immediate and specific. 10,000 is far past any real deck and keeps every downstream
   *  `slide`/`at`/`to` arithmetic total. */
  slide: z.number().int().positive().max(10_000).optional(),
  /** `format` ONLY — which text area to format. Required for `format`; there is no default, because
   *  guessing between a slide's title and its body would put formatting somewhere the caller did not
   *  ask for. */
  placeholder: SlidesPlaceholder.optional(),
  /** `format` ONLY. */
  align: SlidesAlign.optional(),
  /** `format` ONLY. */
  lineSpacing: SlidesLineSpacing.optional(),
  /** `format` ONLY — true sets, false clears, absent leaves alone. **Must stay a boolean on the
   *  wire**: the underlying engine slots toggle when their argument is missing or mistyped, and the
   *  item never rejects a bad value — it coerces it to `false`. A non-boolean would therefore not
   *  fail, it would silently turn the attribute OFF while reporting success. */
  bold: z.boolean().optional(),
  /** `format` ONLY — see `bold`. */
  italic: z.boolean().optional(),
  /** `format` ONLY — see `bold`. */
  underline: z.boolean().optional(),
  /** `set_text` ONLY — the new title placeholder text. Same absent-means-untouched contract `sheets
   *  format`'s attributes already established: naming only `title` leaves `body` exactly as it was,
   *  and vice versa — at least one of the two must be present (checked below; naming neither would do
   *  nothing). Capped well under `PANEL_COMMAND_ARGS_MAX_JSON_BYTES` (8 KiB total) alongside `body`. */
  title: z.string().max(500).optional(),
  /** `set_text` ONLY — the new body/outline placeholder text. Same absent-means-untouched contract as
   *  `title` above. */
  body: z.string().max(5000).optional(),
  /** `add_slide` ONLY — the 1-based position the NEW slide is inserted AT (existing slides at or past
   *  this position shift down by one). Omitted appends at the end — matches `sheets add_sheet`'s own
   *  v1 "no position operand, always appends" default for the omitted case, while `slides` (unlike
   *  `sheets`) also supports naming a real position, per spec §2's own `at?` column. */
  at: z.number().int().positive().max(10_000).optional(),
  /** `add_slide` ONLY — which layout the new slide starts with. Omitted uses Impress's own default
   *  for a freshly inserted slide (whatever that build's own "new slide" command produces). */
  layout: SlidesLayoutPreset.optional(),
  /** `reorder` ONLY — the 1-based position `slide` moves TO. Required for `reorder` (checked below) —
   *  there is no sensible reorder without a target. */
  to: z.number().int().positive().max(10_000).optional(),
  /** `batch` ONLY — several slide operations applied IN ORDER, in ONE call.
   *
   *  **Why it exists.** `add_slide`/`delete_slide`/`reorder` are the position-based, non-idempotent
   *  slide verbs, and building a deck means many of them. Each as its own tool call pays a whole
   *  open+save cycle plus its own enqueue behind the app's ONE app-wide office request queue; all of
   *  them in one call pay that once.
   *
   *  **Bounded twice, both computed.** `OFFICE_BATCH_MAX_OPS` (20) is a TIME bound — the whole batch
   *  rides ONE helper request and so ONE 30 s request timeout — mirrored app-side in
   *  `OfficeWireBatchLimits.maxOperationsPerBatch`, which is the load-bearing copy. Serialized size
   *  is checked separately, before dispatch, against the same 8 KiB cap the wire enforces.
   *
   *  Element operands are the single verbs' own, with the same combination rules: an `add_slide`
   *  element may carry `at`/`layout` and must not carry `slide`/`to`; a `delete_slide` element needs
   *  `slide` alone; a `reorder` element needs `slide` and `to`. Every index is bounded exactly as its
   *  top-level twin is, for exactly the same reason (`1e30` is an integer to `Number.isInteger`, and
   *  an unbounded index reaches an `Int(Double)` app-side that TRAPS and aborts the app). A malformed
   *  element refuses the WHOLE batch, naming its 1-based index. */
  ops: z.array(z.object({
    op: z.enum(["add_slide", "delete_slide", "reorder"]),
    slide: z.number().int().positive().max(10_000).optional(),
    at: z.number().int().positive().max(10_000).optional(),
    to: z.number().int().positive().max(10_000).optional(),
    layout: SlidesLayoutPreset.optional(),
  })).min(1).max(OFFICE_BATCH_MAX_OPS).optional(),
});
type SlidesArgs = z.infer<typeof SlidesArgs>;

// ================================================================================================
// The fence (spec §5 — narrower than write/edit's resolveWithinAny; mirrors sheets.ts's own fence
// semantics exactly, own wording, not imported — see this file's own header for why duplicated)
// ================================================================================================

/**
 * PURE. Mirrors `officeAgentResolvedPathWithinFence`'s exact semantics (`OfficeAgentBroker.swift`) and
 * `officeSheetsResolvedPathWithinFence`'s identical TS-side shape (`sheets.ts`) — the three
 * independently-maintained fences must agree on every case. See `sheets.ts`'s own copy of this
 * function for the full reasoning (symlink-hardening disclosure, `dirs.length === 0` semantics,
 * relative-path-resolves-against-primary) — not repeated here verbatim to avoid two copies of the
 * same essay drifting apart in PROSE while the CODE itself already has to stay byte-identical logic.
 */
/** Delegates to the ONE shared, symlink-hardened office fence (`sheets.ts`'s
 *  `officeResolvedPathWithinFence`). This used to be a byte-identical copy of it; whole-branch
 *  review F4 found the copies were all symlink-blind and each disclosure pointed at a different
 *  layer as the hardened one, so there is now a single body to harden and a single one to read.
 *  `slides.ts` already imported `officeTimeoutMessage` from `sheets.ts`, so this adds no new
 *  dependency edge. */
const officeSlidesResolvedPathWithinFence = officeResolvedPathWithinFence;

/** Collapses `.`/`..`/duplicate slashes and drops a trailing slash — byte-identical to `sheets.ts`'s
 *  own copy (see that file's header for why this is not shared as an import: a tiny pure function,
 *  cheaper to duplicate than to introduce a new shared module for). */
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
// Reach (spec §3, mirroring browser.ts's panelReach / sheets.ts's officeReach — own wording, shared
// canHostPanel predicate)
// ================================================================================================

type OfficeReach = { ok: true } | { ok: false; reason: string };

function officeReach(deps: SlidesToolDeps, sessionId: string): OfficeReach {
  const attached = deps.harnesses(sessionId);
  const usable = attached.filter(canHostPanel);
  if (usable.length > 0) return { ok: true };
  if (attached.length === 0) {
    return {
      ok: false,
      reason: "office tools unavailable — the Mac app isn't showing this session, so nothing can "
        + "open the presentation (it may be closed, or open on a different session). Nothing was read.",
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
// Abort handling — a small, local copy of sheets.ts's own settleOrAbort/ABORTED (that file's own
// non-coupling posture, extended: the two OFFICE tools share a registry and a wire, still nothing
// else).
// ================================================================================================

const ABORTED = Symbol("slides-command-aborted");

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

export interface SlidesToolDeps {
  /** `PanelCommandRegistry.dispatch` — identical contract `sheets.ts`'s own deps document. */
  dispatch(cmd: {
    sessionId: string;
    action: PanelCommandAction;
    args?: Record<string, unknown>;
    deadlineMs: number;
  }): { commandId: string; settled: Promise<PanelCommandOutcome> };
  /** `SessionHub.attachedHarnesses` — identical shape `sheets.ts`'s own deps use. */
  harnesses(sessionId: string): ReadonlyArray<{ clientName: string; role?: string | null }>;
  /** The session's own raw working directories — `store.dirs(sessionId)`, matching `sheets.ts`'s own
   *  `dirsOf`, so the two independently-maintained fences agree on what "this session's working
   *  directories" means. */
  dirsOf(sessionId: string): SessionDirs;
}

export function registerSlidesTool(r: ToolRegistry, deps: SlidesToolDeps): void {
  r.register({
    name: "slides",
    description:
      "Read and edit a presentation Norma has access to (.pptx, .odp — any format the office engine "
      + "can open). Every write verb SAVES immediately — there is no separate save step, and you "
      + "cannot undo from here. A HUMAN can: if they have the file open in a tab, one press of ⌘Z "
      + "takes back your whole tool call, and ⌘⇧Z puts it back. "
      + "Slides are numbered 1-based, matching how a human counts them — every verb below targets a "
      + "slide BY THAT NUMBER ONLY, never by its name (see info's own entry for why a slide's name is "
      + "not a stable way to refer to it). Pick a verb:\n"
      + "• info — path. Slide count, and for each slide its own `name` and `title`, as two DISTINCT "
      + "things: `name` is this engine's own bookkeeping label — for a slide nobody has explicitly "
      + "renamed, it is just \"Slide 3\", recomputed from POSITION on every call, so it changes after "
      + "a reorder and is never a reliable way to identify a slide across calls; `title` is the real "
      + "text in the slide's own title placeholder (absent if it has none). info never reports a "
      + "layout — the underlying engine has no way to read one back once set, only to set one (see "
      + "add_slide). Start here: it also doubles as a check that the Mac app can actually open "
      + "documents right now.\n"
      + "• read — path, slide. Returns the slide's title and body placeholder text (when "
      + "present).\n"
      + "• set_text — path, slide, and at least one of title/body. An ABSENT key means "
      + "\"leave this placeholder alone\" — never \"clear it\": set_text title:\"Q3\" then, in a "
      + "separate call, set_text body:\"...\" on the same slide, and the title from the first call "
      + "survives. A slide with no title or body placeholder to begin with refuses naming the reason, "
      + "rather than inventing one.\n"
      + "• add_slide — path, optional at (1-based position; omitted appends at the end, "
      + "shifting nothing), optional layout — a WRITE-ONLY choice (\"title_slide\"/\"title_content\"/"
      + "\"title_two_content\"/\"title_content_two_content\"/\"title_content_over_content\"/"
      + "\"title_two_content_content\"/\"title_two_content_over_content\"/\"title_four_content\"/"
      + "\"title_only\"/\"blank\"/\"vertical_title_vertical_content_over_vertical_content\"/"
      + "\"vertical_title_vertical_content\"/\"title_vertical_content\"/\"title_two_vertical_content\"/"
      + "\"centered_text\"/\"title_six_content\" — the exact layouts a human sees in Impress's own "
      + "layout picker; info can never report which one a slide currently has, since the engine gives "
      + "no way to ask). Returns the new slide count.\n"
      + "• delete_slide — path, slide. Refused if it would delete the presentation's LAST "
      + "slide.\n"
      + "• reorder — path, slide (which slide), to (the 1-based position it moves to).\n"
      + "\u2022 batch \u2014 path, ops (a list of up to 20 operations, applied IN ORDER, in one "
      + "call). Use this whenever you need more than one of add_slide/delete_slide/reorder \u2014 building a "
      + "deck is the normal case. It is faster than separate calls because the whole batch "
      + "opens the document once, applies every operation, and saves once.\n"
      + "  Each operation is {op: \"add_slide\"|\"delete_slide\"|\"reorder\", slide, at, to, layout} \u2014 the same operands those verbs take singly.\n"
      + "  WHAT A FAILED BATCH DOES, exactly: operations run in order and STOP at the first "
      + "failure. If any operation fails, NOTHING IS SAVED \u2014 the file on disk still holds its "
      + "previous contents, and the refusal tells you which operation failed, why, how many "
      + "applied before it, and which were never attempted. On disk a batch is all-or-nothing. "
      + "This never saves a partial batch to salvage it: a silent partial write you did not ask "
      + "for would be worse than a truthful refusal. One caveat you must act on: if a human "
      + "already had the file open in a tab, the operations that DID apply are sitting unsaved in "
      + "their tab, and every later write to that file will be refused until they save or discard "
      + "them \u2014 retrying cannot clear that; only they can. The refusal says which case you are in.\n"
      + "  Every operation that reports as applied was VERIFIED by re-reading the document \u2014 not "
      + "merely dispatched. A timeout is still OUTCOME UNKNOWN: because the batch saves once at the "
      + "end, either all of it reached the file or none of it did, so a single info call tells you "
      + "which. Never re-send a batch on a timeout without reading first \u2014 these operations are "
      + "position-based, so a blind resend can act on the wrong slide entirely.\n"
      + "add_slide/delete_slide/reorder can each change which slide is shown as ACTIVE in a "
      + "document a human already has open — a real, visible side effect on that tab (mirrors "
      + "sheets' own rename_sheet residual; each of these three verbs' own mechanism moves the "
      + "primary view's current slide to do its work, not merely reorder's).\n"
      + "• format — path, slide, placeholder (\"title\" or \"body\"), and at least one of bold/italic/underline (true or false), align (left/center/right/justify) or lineSpacing (single/1.5/double). Formats ALL of that placeholder's text — there is no way to format part of it.\n"
      + "  Two differences from docs format, both real limits of the presentation editor "
      + "rather than Norma: there is no 1.15 line spacing (only single, 1.5, double), and "
      + "there are no paragraph styles like heading1. Also, aligning a placeholder "
      + "re-anchors the whole text box, not just the text inside it.\n"
      + "  Unlike docs format, this cannot read the formatting back to check it — a "
      + "presentation gives Norma no way to do that — so it reports what it asked for. "
      + "Reopen the slide if you need to be sure.\n"
      + "Every path must be inside this session's own working directories — an office read/write "
      + "COPIES the file and parses it with LibreOffice, so it is not an ordinary file read/write and "
      + "the usual unrestricted-reads rule does not cover it.\n"
      + "The Mac app has to be running and showing this session, or nothing here can work — "
      + "info's own refusal tells you if that's the problem.\n"
      + "A document a human has open with UNSAVED changes refuses every write, naming the tab — "
      + "save or discard those edits first.\n"
      + "**A timeout means the outcome is UNKNOWN, never that a write failed to happen** — the "
      + "app may have completed it and lost the race home. Re-read the document before ever retrying "
      + "a write verb; never blind-retry set_text/add_slide/delete_slide/reorder on a timeout alone. "
      + "add_slide/delete_slide/reorder are POSITION-based and NOT safe to resend even once you "
      + "believe the first attempt landed — a slide's own position can shift between calls, so a "
      + "retry can act on the wrong slide entirely; re-read with info/read first. set_text is the one "
      + "exception worth naming: title/body each set an ABSOLUTE state, so re-sending the exact same "
      + "set_text call after a timeout converges rather than doubles — but re-reading first is "
      + "still the honest way to confirm what actually happened before deciding to resend.",
    modes: ["code", "dispatch"],
    args: SlidesArgs,
    async run(a: SlidesArgs, ctx) {
      const sessionId = ctx.sessionId;
      const action = `office.slides.${a.verb}` as OfficeCommandAction;
      const slideVerbs = new Set(["read", "set_text", "delete_slide", "reorder", "format"]);

      // Rung 1 — operands, per verb. Missing -> malformed, never defaulted (sheets.ts's own
      // wire-strictness rule, carried here unchanged).
      if (slideVerbs.has(a.verb) && a.slide === undefined) {
        throw new Error(`slides ${a.verb} needs a \`slide\` naming which slide (1-based) to act on `
          + `— e.g. verb:"${a.verb}", path:"...", slide:1, ...`);
      }
      if (a.verb === "set_text") {
        if (a.title === undefined && a.body === undefined) {
          throw new Error("slides set_text needs at least one of `title`, `body` — an absent key "
            + "means \"leave alone,\" so a call naming neither would do nothing.");
        }
      }
      if (a.verb === "batch") {
        if (!a.ops || a.ops.length === 0) {
          throw new Error("slides batch needs `ops` — a non-empty list of operations applied in order.");
        }
        // Per-element combination rules, refusing the WHOLE batch and naming the 1-based index. The
        // schema knows each element's field TYPES; it cannot express which fields a given `op`
        // requires or forbids — the same reason the single verbs' rules live in this ladder.
        for (let i = 0; i < a.ops.length; i++) {
          const o = a.ops[i]!;
          const n = i + 1;
          if (o.op === "add_slide") {
            if (o.slide !== undefined || o.to !== undefined) {
              throw new Error(`slides batch operation ${n} is an add_slide — it takes \`at\` and `
                + "`layout`, never `slide` or `to`.");
            }
          } else if (o.op === "delete_slide") {
            if (o.slide === undefined) {
              throw new Error(`slides batch operation ${n} is a delete_slide and needs \`slide\` — `
                + "which slide (1-based) to remove.");
            }
            if (o.at !== undefined || o.to !== undefined || o.layout !== undefined) {
              throw new Error(`slides batch operation ${n} is a delete_slide — it takes \`slide\` and `
                + "nothing else.");
            }
          } else {
            if (o.slide === undefined || o.to === undefined) {
              throw new Error(`slides batch operation ${n} is a reorder and needs both \`slide\` and `
                + "`to` — the 1-based slide to move and where it goes.");
            }
            if (o.at !== undefined || o.layout !== undefined) {
              throw new Error(`slides batch operation ${n} is a reorder — it takes \`slide\` and \`to\`, `
                + "and nothing else.");
            }
          }
        }
      }
      // **Exhaustive over every optional operand, not just the formatting ones** — the same closure
      // `docs.ts` carries, for the same reason and after the same review finding. A key this verb
      // cannot honour REFUSES; it is never dropped (which would report success for something not
      // done) and never allowed to fall back to a wider default (which would change more of the
      // user's file than they asked for). `path` and `verb` are required and excluded by
      // construction; the earlier per-verb checks keep their better-worded refusals and run first.
      const OPERAND_VERBS: Record<string, ReadonlyArray<SlidesArgs["verb"]>> = {
        slide: ["read", "set_text", "delete_slide", "reorder", "format"],
        title: ["set_text"], body: ["set_text"],
        at: ["add_slide"], to: ["reorder"], layout: ["add_slide"], ops: ["batch"],
        placeholder: ["format"], align: ["format"], lineSpacing: ["format"],
        bold: ["format"], italic: ["format"], underline: ["format"],
      };
      for (const [key, allowedVerbs] of Object.entries(OPERAND_VERBS)) {
        if (a[key as keyof SlidesArgs] === undefined) continue;
        if (allowedVerbs.includes(a.verb)) continue;
        const takenBy = allowedVerbs.map((v) => `\`${v}\``).join(" or ");
        throw new Error(`slides ${a.verb} has no \`${key}\` — that operand belongs to ${takenBy}. `
          + "Nothing was changed. (Norma refuses an operand it cannot honour rather than ignoring "
          + "it, because ignoring one would report success for something it did not do.)");
      }
      if (a.verb === "format") {
        if (a.placeholder === undefined) {
          throw new Error("slides format needs a `placeholder` — either \"title\" or \"body\". A slide "
            + "has no other addressable text, and guessing between the two would format something you "
            + "did not ask for.");
        }
        if (a.align === undefined && a.lineSpacing === undefined
            && a.bold === undefined && a.italic === undefined && a.underline === undefined) {
          throw new Error("slides format needs at least one of `bold`, `italic`, `underline`, "
            + "`align`, `lineSpacing` — it has nothing to do otherwise. Nothing was changed.");
        }
      }
      if (a.verb === "reorder") {
        if (a.to === undefined) {
          throw new Error("slides reorder needs `to` — the 1-based position `slide` moves to "
            + "(e.g. slide:3, to:1).");
        }
      }

      // Rung 2 — the fence. Runs BEFORE reach, mirroring sheets.ts's own ordering (that file's own
      // header explains why: a path that could never be allowed must refuse the same way whether or
      // not the app happens to be attached at this instant).
      const resolvedPath = officeSlidesResolvedPathWithinFence(a.path, deps.dirsOf(sessionId));
      if (!resolvedPath) {
        throw new Error(`path is outside the allowed directories: ${a.path}. Norma's office tools `
          + "are limited to the session's working directories.");
      }

      // Rung 3 — reach (the only TRANSIENT rung, checked last, mirroring sheets.ts's own "permanent
      // facts before transient ones" ladder).
      const reach = officeReach(deps, sessionId);
      if (!reach.ok) throw new Error(reach.reason);

      if (ctx.signal?.aborted) {
        return `slides ${a.verb} was not sent — the turn was interrupted first.`;
      }

      let args: Record<string, unknown>;
      if (a.verb === "info") {
        args = officeCommandArgs(resolvedPath);
      } else if (a.verb === "read" || a.verb === "delete_slide") {
        args = officeCommandArgs(resolvedPath, { slide: a.slide! });
      } else if (a.verb === "set_text") {
        // Built conditionally, one key at a time — mirroring `sheets format`'s own discipline
        // (that file's own comment: JSON has no way to say "this key is present but means nothing,"
        // so the absent-key contract has to be enforced HERE, not hoped for downstream).
        const fields: Record<string, string | number> = { slide: a.slide! };
        if (a.title !== undefined) fields.title = a.title;
        if (a.body !== undefined) fields.body = a.body;
        args = officeCommandArgs(resolvedPath, fields);
      } else if (a.verb === "add_slide") {
        const fields: Record<string, string | number> = {};
        if (a.at !== undefined) fields.at = a.at;
        if (a.layout !== undefined) fields.layout = a.layout;
        args = officeCommandArgs(resolvedPath, fields);
      } else if (a.verb === "batch") {
        args = officeSlidesBatchArgs(resolvedPath, a.ops!);
        const tooLarge = officeBatchArgsTooLarge(args, a.ops!.length);
        if (tooLarge) throw new Error(`slides batch: ${tooLarge}`);
      } else if (a.verb === "reorder") {
        args = officeCommandArgs(resolvedPath, { slide: a.slide!, to: a.to! });
      } else if (a.verb === "format") {
        // Conditional construction, one key at a time — the absent-means-untouched contract.
        const fields: Record<string, string | number | boolean> = {
          slide: a.slide!, placeholder: a.placeholder!,
        };
        if (a.align !== undefined) fields.align = a.align;
        if (a.lineSpacing !== undefined) fields.lineSpacing = a.lineSpacing;
        if (a.bold !== undefined) fields.bold = a.bold;
        if (a.italic !== undefined) fields.italic = a.italic;
        if (a.underline !== undefined) fields.underline = a.underline;
        args = officeCommandArgs(resolvedPath, fields);
      } else {
        args = officeCommandArgs(resolvedPath);
      }

      const deadlineMs = OFFICE_DEADLINES_MS[action];
      const { settled } = deps.dispatch({ sessionId, action, args, deadlineMs });

      const outcome = await settleOrAbort(settled, ctx.signal);

      if (outcome === ABORTED) {
        return `slides ${a.verb} was interrupted before the Mac app answered.`;
      }

      if (outcome.kind === "timeout") {
        throw new Error(officeTimeoutMessage(`slides ${a.verb}`, outcome.deadlineMs));
      }

      if (!outcome.ok) {
        throw new Error(outcome.result ?? `slides ${a.verb} could not be completed for ${a.path}`);
      }

      return outcome.result ?? `slides ${a.verb} completed for ${a.path}`;
    },
  });
}
