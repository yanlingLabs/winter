import { z } from "zod";
import { OFFICE_DEADLINES_MS, officeCommandArgs, type OfficeCommandAction } from "../../panel/office-commands";
import type { ToolRegistry } from "./registry";
import type { PanelCommandAction, PanelCommandOutcome } from "../../panel/commands";
import type { SessionDirs } from "../../sessions/dirs";
import { canHostPanel } from "./browser";
import { officeTimeoutMessage, officeResolvedPathWithinFence } from "./sheets";

/**
 * `docs` (office-agent-tools T7, task-7-brief.md; design
 * `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §2 (`docs` table), §3, §4, §5) —
 * the agent's vocabulary for Writer text documents, and the LAST tool in Stage C. Same
 * `panel_command` bridge `sheets` (T1-T5) and `slides` (T6) already proved, driving LibreOfficeKit's
 * Writer engine instead of Calc or Impress. Verbs: `info` (page/paragraph/character counts — also the
 * drivability probe, spec §1/§3), `read` (whole document or a paragraph range), `replace`
 * (literal find/replace), `insert`, `append`.
 *
 * ## Four ratified rulings, from `docs-lok-research.md` (2026-08-24) — implemented, not relitigated
 *
 * 1. **`replace` counts in OUR code, and `find` is LITERAL-ONLY.** The engine computes a real match
 *    count and then throws it away: `nFound` is collapsed to a bool at
 *    `sw/source/uibase/uiview/viewsrch.cxx:395`, its only other sink is a localized findbar string
 *    that does not exist headless, and `unoAnyToJson` cannot serialize even that bool's VALUE. The
 *    single reachable bit is `success` in `LOK_CALLBACK_UNO_COMMAND_RESULT`. So the app counts the
 *    matches itself over the text it just read, and **verifies by re-reading the document and
 *    comparing it to the exact text the replacement should have produced** — throwing, with the
 *    outcome reported as UNKNOWN, when it does not match.
 *
 *    ⚠️ **The ruling's own engine cross-check ("throw on disagreement with `success`") is WIRED BUT
 *    UNREACHABLE on this bridge, measured, and must not be described as shipped.** The listener is
 *    built against `mpCallbackFlushHandlers[getViewId(docId)]`, and `setView`'s own hop 4
 *    (`SfxApplication::SetViewFrame_Impl` → `MoveShellToFirstShell`) moves the newly-current shell
 *    to the head of the very list `getViewId` scans — so `getViewId` returns the AGENT view, which
 *    has no `registerCallback`, and no `DispatchResultListener` is ever constructed. Measured:
 *    `observed=none` on every replace, and no type-16 callback in a full raw trace. The consumer
 *    stays wired (correct if one ever arrives, and it treats "no result" as *no cross-check
 *    available*, never as agreement). What actually does the verifying is the re-read above, which
 *    is strictly stronger — it knows what the text should BE, not merely that something changed —
 *    and it is what caught the one real bug here (a case-insensitive engine match). See
 *    `LOKBridge.docsReplaceOnDedicatedThread` and `task-7-report.md` §5.1. `find` is
 *    therefore literal — a regex or wildcard would let our count and the engine's matching diverge
 *    silently, and a wrong count lands in the user's saved file. Named follow-up: regex/wildcard
 *    search, widened deliberately.
 * 2. **`insert`/`append` use `paste`, NOT `.uno:InsertText`.** `InsertText` is a silent no-op on bad
 *    args (`if (pItem)`, `sw/source/uibase/shells/textsh.cxx:153-156`) *and* costs roughly one undo
 *    step per word — a user's single ⌘Z after an agent edit would get back the last WORD. `paste` is
 *    one undo step, synchronous, and returns a real boolean.
 * 3. **`read` is `.uno:SelectAll` + `getTextSelection`** — UTF-8, `\n` paragraph breaks, no engine
 *    size cap (so the cap is OURS, app-side, and disclosed in the result). It **deep-copies the whole
 *    document** into a temporary `SwDoc` before serializing, so its cost scales with DOCUMENT size,
 *    not with the text returned. **`info`'s page count is `getParts()`** (for Writer, LOK's parts ARE
 *    pages) — free, but it can under-report before layout completes. **No paragraph query exists at
 *    all**, so the paragraph count is derived from `read`'s own text: one measurement, not two
 *    disagreeing ones.
 * 4. **Writer's caret and selection ARE per-view** (confirmed through an 8-hop chain from
 *    `SfxLokHelper::setView` to `SwView::Activate` -> `SwDocShell::SetView`), so Stage B's
 *    `createAgentView` + `setView` architecture carries over unchanged and an agent edit does not
 *    move the user's caret. The ruling's second half — "the undo stack is SHARED across views, so an
 *    agent edit lands in the user's own ⌘Z stack" — is structurally true (`sw::UndoManager` hangs off
 *    `SwDoc`, not off `SwView`), and **as of office-live-edit R3 its user-facing conclusion is true
 *    as well.**
 *
 *    The history is worth keeping, because it is why the fix looks the way it does. T7 falsified the
 *    conclusion live: in LOK mode and OUTSIDE REPAIR MODE, `sw::UndoManager::GetLastUndoInfo`
 *    (`sw/source/core/undo/docundo.cxx:456-472`) REFUSES an undo whose top action belongs to another
 *    view, and its one escape hatch (`IsViewUndoActionIndependent`, `:367-430`) requires both actions
 *    to be `SwUndoId::TYPING` — a `PASTE_CLIPBOARD` never qualifies. So a human's ⌘Z could not take
 *    back a `docs` edit, and silently did nothing.
 *
 *    **The five words doing the work in that sentence are "outside repair mode."** R3 dispatches ⌘Z
 *    with the slot's own `Repair` argument (`sfx2/sdi/sfx.sdi:4719-4720`), which skips that gate in
 *    all three apps — proven live against the SHIPPED engine, beside a non-repair control arm in the
 *    same run, in `OfficeRuntimeLiveTests.testRepairArgumentLetsAPrimaryViewUndoTakeBackAnAgentViewEdit`.
 *    The T7 test above still exists and still runs; it was INVERTED and renamed
 *    (`testLiveAHumanUndoTakesBackAWholeAgentEditInOnePress`), and inverted it is its own positive
 *    control — its claim is now that the text disappears, so a ⌘Z that silently did nothing fails it.
 *    Ruling 4's "named follow-up, deliberately not attempted in v1" is therefore DELIVERED.
 *
 * ## Two deliberate v1 narrowings, surfaced rather than smuggled
 *
 * Both follow the precedent T4's `set` grid and T5's `numberFormat` presets set — deviate from spec
 * §2's compressed operand table where the engine makes the table's shape dishonest, and say so.
 *
 * - **`all: false` is REFUSED, not approximated.** The operand stays in the schema (dropping it would
 *   let zod strip an `all: false` a model meant, and replace everything while reporting success), but
 *   only `true` is accepted. `SvxSearchCmd::REPLACE` (2) is not "replace the first occurrence": it is
 *   the UI Replace BUTTON — replace the current selection if it matches, then find the next
 *   (`viewsrch.cxx:321-358`), and with no selection it replaces AT THE CURSOR. Stateful,
 *   order-dependent, and its mistakes land in the user's file. Named follow-up: first-only replace,
 *   composed as FIND-then-REPLACE and live-proven, if something needs it.
 * - **`read`'s range is PARAGRAPHS, and the slice is taken by us.** LOK exposes no character- or
 *   paragraph-indexed addressing for Writer at all (`setTextSelection` takes twips; there is no
 *   paragraph door — research §3.5). A paragraph range is therefore an honest slice of the SAME
 *   `\n`-separated text `read` returns and `info` counts, never a range the engine was asked for.
 *   That self-consistency is the property that matters. It also means a paragraph range does NOT make
 *   the read cheaper — the whole document is still read and deep-copied first. Said in the
 *   description.
 *
 * ## Numeric operands are bounded at BOTH layers, on arrival
 *
 * `fromParagraph`/`toParagraph` are this tool's ONLY numeric operands, and both carry a `.max()`
 * here AND an independent ceiling app-side (`OfficeCommandConsumer.officeDocsMaxParagraphIndex`).
 * This is not belt-and-braces for its own sake: `z.number().int().positive()` is NOT a bound
 * (`Number.isInteger(1e30)` is `true`), the app's `Int(Double)` conversion TRAPS outside `Int`'s
 * range, and a trap aborts Norma.app along with every open document's unsaved edits. That class shipped
 * twice in this arc (`sheets insert_rows at:1e30`, `slides read slide:1e30`), both measured as
 * SIGTRAPs — and `docs.ts` did not exist during the sweep that closed them, so it is outside that
 * sweep by construction. The daemon's ceiling makes the refusal immediate and specific; the app's is
 * what actually makes the arithmetic total, because `panel_command.args` is
 * `z.record(z.string(), z.unknown())` with only a byte cap and the daemon is not the only possible
 * producer of one.
 *
 * ## Inherited wholesale from `sheets.ts`/`slides.ts`, not reinvented
 *
 * The fence, `officeReach`, the abort handling and the whole `run()` ladder (per-verb operand
 * validation -> fence -> reach -> dispatch -> settle) are copy-adapted, exactly as `slides.ts` was.
 * `officeTimeoutMessage` is the one piece IMPORTED rather than duplicated, for the reason `slides.ts`
 * gives: every office tool must say the identical OUTCOME-UNKNOWN sentence (spec §4's durable
 * contract), and duplicating its wording would let the texts drift.
 */

// ================================================================================================
// Operands
// ================================================================================================

/** `insert`'s own position. A CLOSED two-value enum, the same posture `slides`' `layout` and
 *  `sheets`' `numberFormat` ship: the only argument-less, non-async, dialog-free positioning commands
 *  Writer exposes are `.uno:GoToStartOfDoc` and `.uno:GoToEndOfDoc` (research §6.4), so anything
 *  finer would be promising an addressing scheme LOK does not have. Raw values MUST match the Swift
 *  side's `OfficeCommandConsumer.OfficeDocsInsertAt` byte-for-byte — a wire string decoded
 *  independently on both ends. */
const DocsInsertAt = z.enum(["start", "end"]);

const DocsArgs = z.object({
  verb: z.enum(["info", "read", "replace", "insert", "append"]),
  /** Absolute (or resolved against the session's primary working directory if relative) — spec §2's
   *  own table. Required for EVERY verb; a missing path is malformed, never defaulted. */
  path: z.string().min(1).max(4096),
  /** `read` ONLY — the 1-based paragraph to start at (inclusive). Omitted starts at paragraph 1.
   *  **Bounded** — see this file's own header for why `.int().positive()` alone is not a bound and
   *  what the unbounded version of this operand does to the app. 1,000,000 is orders of magnitude
   *  past any real document. */
  fromParagraph: z.number().int().positive().max(1_000_000).optional(),
  /** `read` ONLY — the 1-based paragraph to stop at (INCLUSIVE). Omitted reads to the end; a value
   *  past the last paragraph clamps to it (asking for "2 to 100" of a 5-paragraph document is an
   *  ordinary way to say "from 2 to the end"). Same ceiling, same reason, as `fromParagraph`. */
  toParagraph: z.number().int().positive().max(1_000_000).optional(),
  /** `replace` ONLY — the LITERAL text to find. Case-sensitive, never a regex or wildcard (ruling 1).
   *  Must not contain a line break: the engine's search never matches across a paragraph boundary, so
   *  a multi-line `find` would silently match nothing while our own count over `\n`-joined text
   *  happily would — a guaranteed divergence, i.e. a guaranteed trip of ruling 1's own tripwire, on
   *  input a model can produce by accident. Capped well under `PANEL_COMMAND_ARGS_MAX_JSON_BYTES`
   *  (8 KiB total) alongside `replaceWith`. */
  find: z.string().min(1).max(2000).optional(),
  /** `replace` ONLY — what each occurrence becomes. **May be empty** (that is how you delete every
   *  occurrence) but must be PRESENT: absent-means-empty would silently turn a forgotten operand into
   *  a deletion. Same no-line-break rule as `find`, for the other half of the same reason — the
   *  engine inserts a `\n` as literal characters, not as a paragraph break, so our expected text and
   *  the document's would diverge. Use `append`/`insert` to add paragraphs. */
  replaceWith: z.string().max(2000).optional(),
  /** `replace` ONLY — kept in the schema so a model that passes `false` gets a REFUSAL naming the
   *  reason, rather than having zod strip the key and silently replacing everything. Only `true` is
   *  accepted in v1; see this file's own header for the engine reason. */
  all: z.boolean().optional(),
  /** `insert`/`append` ONLY — the text to add. Capped under the 8 KiB args ceiling; a longer body
   *  should be added in more than one call.
   *
   *  ⚠️ **The "also better for the shared undo stack" half of this note was REMOVED in
   *  office-live-edit R3, because its premise inverted.** It argued that more calls give the human
   *  finer undo granularity. One tool call is now exactly ONE undo step (bracket-and-count —
   *  `OfficeUndoLedger`), so splitting a body across N calls now costs the human N presses of ⌘Z to
   *  take back one logical edit. Splitting is still right for the byte cap; it is no longer an undo
   *  argument, and it pointed the other way. */
  text: z.string().min(1).max(4000).optional(),
  /** `append` ONLY (office-live-edit R2) — **several paragraphs in ONE call.** Mutually exclusive
   *  with `text`; passing both refuses rather than picking one.
   *
   *  **Why this is not a new wire shape.** The daemon joins these with `\n` and sends the SAME
   *  single-`text` frame the one-paragraph form already sends, because `append` is implemented as a
   *  single `paste` of `text/plain` and a pasted `\n` is a real paragraph break — **measured, not
   *  assumed** (`OfficeDocsCommandTests.testLiveOnePasteWithNewlinesBecomesSeveralRealParagraphs`:
   *  a 3-paragraph document plus a 3-marker payload read back as 6 separately numbered paragraphs).
   *  That measurement mattered because `replaceWith`'s note two operands up says the engine inserts
   *  `\n` "as literal characters, not as a paragraph break" — TRUE for `replace`, which goes through
   *  `.uno:ExecuteSearch`, and carrying it across to `paste` without checking would have been this
   *  arc's own right-conclusion-wrong-supporting-fact shape.
   *
   *  Four consequences, all of them why this shape was chosen over an array on the wire:
   *  one helper request (so the write deadline is untouched), ONE `paste`, ONE engine undo action —
   *  so one ⌘Z takes the whole batch back — and the existing verification is unchanged and is
   *  strictly stronger than a per-op ledger: the helper compares the WHOLE resulting document text
   *  against the exact text it predicted, so a batch that lands wrong fails loudly rather than
   *  reporting which ops it believes it did.
   *
   *  Bounds are doubled deliberately: `.max(50)` elements AND a joined-length check in the ladder
   *  against the same 4 000-character ceiling `text` itself carries, because 50 × 2 000 would
   *  otherwise be 100 000 characters aimed at an 8 KiB wire cap whose overflow is an opaque schema
   *  error rather than a useful refusal. */
  texts: z.array(z.string().min(1).max(2000)).min(1).max(50).optional(),
  /** `insert` ONLY — "start" or "end" of the document. Omitted means "end". `append` ignores it (it
   *  is always the end, by definition) and refuses it rather than accepting a value it would not
   *  honour. */
  at: DocsInsertAt.optional(),
});
type DocsArgs = z.infer<typeof DocsArgs>;

// ================================================================================================
// The fence (spec §5 — mirrors sheets.ts/slides.ts's own fence semantics exactly, own copy, not
// imported; see slides.ts's own header for why duplicated rather than shared)
// ================================================================================================

/** Delegates to the ONE shared, symlink-hardened office fence (`sheets.ts`'s
 *  `officeResolvedPathWithinFence`). This used to be a byte-identical copy of it; whole-branch
 *  review F4 found the copies were all symlink-blind and each disclosure pointed at a different
 *  layer as the hardened one, so there is now a single body to harden and a single one to read.
 *  `slides.ts` already imported `officeTimeoutMessage` from `sheets.ts`, so this adds no new
 *  dependency edge. */
const officeDocsResolvedPathWithinFence = officeResolvedPathWithinFence;

/** Collapses `.`/`..`/duplicate slashes and drops a trailing slash — byte-identical to
 *  `sheets.ts`/`slides.ts`'s own copies. */
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
// Reach (spec §3 — mirrors browser.ts's panelReach / sheets.ts's officeReach)
// ================================================================================================

type OfficeReach = { ok: true } | { ok: false; reason: string };

function officeReach(deps: DocsToolDeps, sessionId: string): OfficeReach {
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
// Abort handling — a local copy of sheets.ts/slides.ts's own settleOrAbort/ABORTED
// ================================================================================================

const ABORTED = Symbol("docs-command-aborted");

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

export interface DocsToolDeps {
  /** `PanelCommandRegistry.dispatch` — identical contract `sheets.ts`/`slides.ts`'s own deps document. */
  dispatch(cmd: {
    sessionId: string;
    action: PanelCommandAction;
    args?: Record<string, unknown>;
    deadlineMs: number;
  }): { commandId: string; settled: Promise<PanelCommandOutcome> };
  /** `SessionHub.attachedHarnesses`. */
  harnesses(sessionId: string): ReadonlyArray<{ clientName: string; role?: string | null }>;
  /** The session's own raw working directories — `store.dirs(sessionId)`, so the three
   *  independently-maintained fences agree on what "this session's working directories" means. */
  dirsOf(sessionId: string): SessionDirs;
}

export function registerDocsTool(r: ToolRegistry, deps: DocsToolDeps): void {
  r.register({
    name: "docs",
    description:
      "Read and edit a text document Norma has access to (.odt, .docx — any format the office engine "
      + "can open). Every write verb SAVES immediately — there is no separate save step, and you "
      + "cannot undo from here. A HUMAN can: if they have the document open in a tab, one press of "
      + "⌘Z takes back your whole tool call, however many edits it made, and ⌘⇧Z puts it back. So a "
      + "write is recoverable BY THEM, not by you — you still cannot reverse your own edit, so read "
      + "before you write. "
      + "Pick a verb:\n"
      + "• info — path. Page, paragraph and character counts. Start here: it also doubles as a check "
      + "that the Mac app can actually open documents right now. The page count comes from the "
      + "engine's own layout and can under-report on a document nothing has displayed yet; the "
      + "paragraph count is exactly the number of paragraphs read returns, so the two always agree.\n"
      + "• read — path, optional fromParagraph/toParagraph (1-based, INCLUSIVE; omit both for the "
      + "whole document). Returns the text with each paragraph numbered, so you can ask for a "
      + "narrower range next time without recounting. A toParagraph past the end simply stops at the "
      + "end; a fromParagraph past the end refuses and tells you how many paragraphs there are. Note "
      + "that a paragraph range does NOT make the read cheaper — the engine can only hand over the "
      + "whole document, and Norma takes the slice — so use it to keep the ANSWER manageable, not to "
      + "speed anything up. A very long document refuses with the limit named; ask for a range.\n"
      + "• replace — path, find, replaceWith, optional all. Replaces EVERY occurrence and reports how "
      + "many. `find` is LITERAL and CASE-SENSITIVE — not a regex, not a wildcard, and it cannot span "
      + "a line break (search one paragraph's worth of text at a time). `replaceWith` may be \"\" to "
      + "delete every occurrence, but you must pass it. There is no way to replace only the FIRST "
      + "occurrence: the office engine has no such operation, so `all: false` is refused rather than "
      + "approximated — make `find` specific enough to match only what you mean.\n"
      + "• insert — path, text, optional at (\"start\" or \"end\"; omitted means the end). Puts "
      + "exactly that text at that position and adds nothing else — no new paragraph, no spacing.\n"
      + "• append — path, and either text (one paragraph) or texts (an ARRAY of paragraphs, added "
      + "in order, up to 50 and 4000 characters in total). Prefer texts when you have several "
      + "paragraphs to add: it is one call instead of several, it costs the user one ⌘Z instead of "
      + "one per paragraph, and it is faster. Adds them at the end as NEW paragraphs. This is the one to use "
      + "for \"add a section/sentence to the end\"; insert at:\"end\" continues the last paragraph "
      + "instead.\n"
      + "Every path must be inside this session's own working directories — an office read/write "
      + "COPIES the file and parses it with LibreOffice, so it is not an ordinary file read/write and "
      + "the usual unrestricted-reads rule does not cover it.\n"
      + "The Mac app has to be running and showing this session, or nothing here can work — info's "
      + "own refusal tells you if that's the problem.\n"
      + "A document a human has open with UNSAVED changes refuses every write, naming the tab — save "
      + "or discard those edits first.\n"
      + "**A timeout means the outcome is UNKNOWN, never that a write failed to happen** — the app "
      + "may have completed it and lost the race home. Re-read the document before ever retrying a "
      + "write verb. insert/append are the dangerous ones to resend: they ADD text, so a blind retry "
      + "after a timeout can add it twice. replace is safer to re-send (replacing text that is no "
      + "longer there does nothing), but re-reading first is still the honest way to confirm what "
      + "actually happened.",
    modes: ["code", "dispatch"],
    args: DocsArgs,
    async run(a: DocsArgs, ctx) {
      const sessionId = ctx.sessionId;
      const action = `office.docs.${a.verb}` as OfficeCommandAction;

      // Rung 1 — operands, per verb. Missing -> malformed, never defaulted.
      if (a.verb === "replace") {
        if (a.find === undefined) {
          throw new Error("docs replace needs a `find` — the literal text to search for "
            + "(e.g. verb:\"replace\", path:\"...\", find:\"old\", replaceWith:\"new\").");
        }
        if (a.replaceWith === undefined) {
          throw new Error("docs replace needs a `replaceWith` — pass \"\" explicitly to delete every "
            + "occurrence of `find`.");
        }
        if (a.find.includes("\n") || a.find.includes("\r")) {
          throw new Error("docs replace's `find` cannot contain a line break — the office engine's "
            + "search never matches across a paragraph boundary, so it would silently find nothing. "
            + "Replace one paragraph's worth of text at a time.");
        }
        if (a.replaceWith.includes("\n") || a.replaceWith.includes("\r")) {
          throw new Error("docs replace's `replaceWith` cannot contain a line break — the engine "
            + "inserts it as literal characters, not as a new paragraph. Use `append` (or `insert`) "
            + "to add paragraphs.");
        }
        if (a.all === false) {
          throw new Error("docs replace cannot replace only the first occurrence — it replaces every "
            + "one, or nothing. The office engine has no \"replace the first match\" operation: its "
            + "Replace command replaces whatever is currently selected and then moves on, which "
            + "depends on where the cursor happens to be. Re-run without `all`, or make `find` "
            + "specific enough to match only the occurrence you mean.");
        }
      }
      // `texts` is an APPEND-only operand, and a present one on any other verb REFUSES rather than
      // being ignored. Ignoring it would silently drop every paragraph after the first — the exact
      // silent-wrong-answer shape `all: false` and `append`'s own `at` are already kept in the schema
      // to prevent.
      if (a.texts !== undefined && a.verb !== "append") {
        throw new Error(`docs ${a.verb} has no \`texts\` — only append takes several paragraphs at `
          + "once. Use verb:\"append\" with texts:[...], or send one `text`.");
      }
      if (a.verb === "insert" || a.verb === "append") {
        if (a.text === undefined && a.texts === undefined) {
          throw new Error(`docs ${a.verb} needs a \`text\` — what to add to the document`
            + (a.verb === "append" ? ", or `texts` for several paragraphs at once." : "."));
        }
        if (a.text !== undefined && a.texts !== undefined) {
          throw new Error(`docs ${a.verb} takes \`text\` OR \`texts\`, not both — passing both leaves `
            + "it ambiguous which one you meant to add, and guessing would put text into the user's "
            + "saved file that they never asked for. Send one of them.");
        }
      }
      if (a.texts !== undefined) {
        // The AGGREGATE bound. The per-element `.max(2000)` and the `.max(50)` array length do not
        // compose to anything safe on their own (50 × 2 000 = 100 000 characters against an 8 KiB
        // wire cap), and the wire cap's own refusal is a field-level zod `.refine` whose message
        // names neither the tool, the verb, nor which paragraph was too long. Refusing here is
        // cheap, specific and actionable — the same reason `sheets.set` checks its cell count before
        // dispatch rather than letting the cap produce an opaque schema error.
        const joinedLength = a.texts.join("\n").length;
        if (joinedLength > 4000) {
          throw new Error(`docs append's \`texts\` total ${joinedLength} characters, over the 4000 `
            + `limit one call can carry (${a.texts.length} paragraphs, joined). Send them in more `
            + "than one call — each call is still one undo step for the human.");
        }
      }
      if (a.verb === "append" && a.at !== undefined) {
        throw new Error("docs append always adds at the end — it has no `at`. Use verb:\"insert\" "
          + "with at:\"start\" to put text at the beginning instead.");
      }
      if (a.verb === "read" && a.fromParagraph !== undefined && a.toParagraph !== undefined
          && a.fromParagraph > a.toParagraph) {
        throw new Error(`docs read's \`fromParagraph\` (${a.fromParagraph}) is after \`toParagraph\` `
          + `(${a.toParagraph}) — they are 1-based and inclusive, so \`from\` must be at most \`to\`.`);
      }

      // Rung 2 — the fence. Runs BEFORE reach, mirroring sheets.ts/slides.ts's own ordering: a path
      // that could never be allowed must refuse the same way whether or not the app happens to be
      // attached at this instant (spec §5's own "a probe outside the working dirs answers with the
      // fence refusal, not the app-not-running one").
      const resolvedPath = officeDocsResolvedPathWithinFence(a.path, deps.dirsOf(sessionId));
      if (!resolvedPath) {
        throw new Error(`path is outside the allowed directories: ${a.path}. Norma's office tools `
          + "are limited to the session's working directories.");
      }

      // Rung 3 — reach (the only TRANSIENT rung, checked last).
      const reach = officeReach(deps, sessionId);
      if (!reach.ok) throw new Error(reach.reason);

      if (ctx.signal?.aborted) {
        return `docs ${a.verb} was not sent — the turn was interrupted first.`;
      }

      let args: Record<string, unknown>;
      if (a.verb === "info") {
        args = officeCommandArgs(resolvedPath);
      } else if (a.verb === "read") {
        // Built conditionally, one key at a time — the same discipline `sheets format`/`slides
        // set_text` use: JSON has no way to say "this key is present but means nothing," so the
        // absent-key contract is enforced HERE rather than hoped for downstream.
        const fields: Record<string, string | number> = {};
        if (a.fromParagraph !== undefined) fields.fromParagraph = a.fromParagraph;
        if (a.toParagraph !== undefined) fields.toParagraph = a.toParagraph;
        args = officeCommandArgs(resolvedPath, fields);
      } else if (a.verb === "replace") {
        // `all` is deliberately NOT forwarded: only `true` survives the validation above, and the
        // app refuses `all: false` on its own too (it cannot trust the daemon to be the only
        // producer of a panel_command). Forwarding a value that can only ever be `true` would be
        // noise on the wire.
        args = officeCommandArgs(resolvedPath, { find: a.find!, replaceWith: a.replaceWith! });
      } else if (a.verb === "insert") {
        const fields: Record<string, string | number> = { text: a.text! };
        if (a.at !== undefined) fields.at = a.at;
        args = officeCommandArgs(resolvedPath, fields);
      } else {
        // append. `texts` never reaches the wire as an array — it is joined into the SAME `text`
        // field the one-paragraph form sends, so the app-side decoder, the helper and the
        // verification are all byte-identically the proven path. Conditional construction as
        // everywhere else: exactly one of the two is defined by the time this runs.
        args = officeCommandArgs(resolvedPath,
                                 { text: a.texts !== undefined ? a.texts.join("\n") : a.text! });
      }

      const deadlineMs = OFFICE_DEADLINES_MS[action];
      const { settled } = deps.dispatch({ sessionId, action, args, deadlineMs });

      const outcome = await settleOrAbort(settled, ctx.signal);

      if (outcome === ABORTED) {
        return `docs ${a.verb} was interrupted before the Mac app answered.`;
      }

      if (outcome.kind === "timeout") {
        throw new Error(officeTimeoutMessage(`docs ${a.verb}`, outcome.deadlineMs));
      }

      if (!outcome.ok) {
        throw new Error(outcome.result ?? `docs ${a.verb} could not be completed for ${a.path}`);
      }

      return outcome.result ?? `docs ${a.verb} completed for ${a.path}`;
    },
  });
}
