/** `<Composer>` (Phase 3a Task 4; re-skinned Phase 3b Task 5; Phase 3c Task 3 — real cursor/editing
 *  model + disk-backed prompt history + double-esc clear). The interactive input line: cursor
 *  navigation and mid-text editing, ↑/↓ prompt-history recall, submit/steer, esc-interrupt (or
 *  double-esc-clear), shift+tab policy-cycle. Presentational only, per 3a's ambiguity resolution
 *  #4 — it renders the given `policy` and forwards key decisions via callbacks; the parent owns the
 *  actual policy value, the setPolicy RPC, and the one-RPC-at-a-time in-flight guard.
 *
 *  Ink's `useInput` hands the handler an already-parsed `key` object, never keys.ts's raw
 *  escape-sequence strings — so `decodeKey` isn't directly reusable here. Ambiguity resolution #1:
 *  a tiny adapter maps Ink's `key` to `decodeKey`'s return enum, then feeds that into
 *  `footerKeyAction` with a constant `focusIndex: null` selection, keeping shiftTab→cyclePolicy in
 *  lockstep with the legacy raw-stdin decision table instead of hardcoding it here. (Footer focus
 *  navigation — up/down/select — is a later task; this component never has footer focus, hence the
 *  fixed `focusIndex: null` / empty `rowThreadIds`. Esc no longer routes through `footerKeyAction`'s
 *  "interrupt" branch unconditionally — see the T3 esc-precedence note below.)
 *
 *  T3 ambiguity — Home/End/Backspace/Forward-Delete: Ink v5's `Key` type has NO field at all for
 *  Home/End (only up/down/left/right/pageUp/pageDown/return/escape/tab/backspace/delete/ctrl/
 *  shift/meta exist — see ink/build/hooks/use-input.js), and `nonAlphanumericKeys` clears `input` to
 *  "" for them too, so they're entirely invisible through the normal `(input, key)` callback. Worse,
 *  the real Backspace key (sends `\x7f` in raw mode on effectively every modern terminal) and the
 *  real Forward-Delete key (`\x1b[3~`) BOTH parse to `key.name === "delete"` — parse-keypress.js
 *  folds them onto the same `key.delete` flag, so that flag alone can't tell them apart either. We
 *  read the exact same raw chunk Ink's own `useInput` consumes — via `useStdin().internal_eventEmitter`,
 *  the "input" event `useInput` itself subscribes to — purely to disambiguate these four keys by
 *  their literal byte sequence. Every other key (insert, arrows, enter, esc, ctrl+a/e, word-jumps,
 *  history ↑/↓) stays on the ordinary `useInput` path below; the two listeners never double-fire on
 *  the same keystroke because Ink clears `input` and leaves every `key.*` flag unhelpful for these
 *  four cases anyway (nothing in the ordinary path reacts to them).
 *
 *  Phase 3b T5 render note (cc-ui-study-chrome.md §1) still holds: an "open" prompt (bare top+bottom
 *  rounded rules, no side walls), a `❯ ` prompt glyph dimmed while a turn runs (glyph ONLY — the
 *  user's typed text never dims). T3 replaces the old trailing block-cursor glyph with a real
 *  cursor position: `❯ ` + `before` + inverse(`at` or a space) + `after`, per `renderWithCursor`
 *  (see `input-model.ts`) — all as ONE root `<Text>`, with the glyph's dim expressed as raw ANSI
 *  codes INSIDE the root string (see the render comment below for why an Ink layout bug forces
 *  that shape). */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { homedir } from "node:os";
import { join } from "node:path";
import { Box, Text, useInput, useStdin } from "ink";
import { Chalk } from "chalk";
import type { ApprovalPolicy } from "@norma/protocol";
import { footerKeyAction } from "../keys";
import type { FooterSelection } from "../task-block";
import { theme } from "./theme";
import {
  backspace,
  del,
  end,
  home,
  insert,
  isMouseArtifact,
  left,
  right,
  renderWithCursor,
  wordLeft,
  wordRight,
  type InputState,
} from "./input-model";
import { appendHistory, loadHistory, makeHistoryNav } from "./history-store";
import { COMMANDS, filterCommands, parseSlashInput } from "./commands";
import { CompletionMenu, MAX_MENU_ROWS } from "./completion-menu";
import { fuzzyMatch } from "./file-index";

/** Phase 3d T3 — the single disabled placeholder row shown while the App-owned file index is
 *  still building (see the `fileIndex` prop doc below). Not a real match, so it's excluded from
 *  every count/gating decision (`fileOpen`, `boundedSelected`, ...) the same way a genuine
 *  zero-match query is — only the render differs (the row still appears; see `menuVisible`). */
const INDEXING_LABEL = "indexing…";

// The composer never has footer keyboard focus (that's a later task) — this is the one constant
// FooterSelection it ever passes to footerKeyAction, selecting the "no footer focus" branch of its
// decision table (down/esc/shiftTab only; rowThreadIds is irrelevant on that branch, hence []).
const NO_FOOTER_FOCUS: FooterSelection = { selectedThreadId: "main", focusIndex: null };

const DOUBLE_ESC_WINDOW_MS = 800;

// See the T3 doc-comment above: raw ANSI sequences for the four keys Ink's `key` object can't (or
// can't unambiguously) represent. Sets, not a single string each, to cover the handful of common
// terminal variants (xterm/vt220/rxvt) for each logical key.
const HOME_SEQS = new Set(["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"]);
const END_SEQS = new Set(["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"]);
const BACKSPACE_SEQS = new Set(["\x7f", "\b", "\x1b\x7f", "\x1b\b"]);
const DELETE_SEQS = new Set(["\x1b[3~", "\x1b[3^", "\x1b[3$"]);

// Fixed-level truecolor Chalk instance — same convention (and reason) as flatten-blocks.ts /
// markdown.ts: the ambient default export downgrades to level 0 under a non-TTY (tests), which
// would silently strip the dim codes the render below bakes into its string.
const ansi = new Chalk({ level: 3 });

function defaultHistoryPath(): string {
  return join(homedir(), ".norma", "history.jsonl");
}

/** Phase 3d T2 — pure predicate: is the `/`-slash-command menu open for this `InputState`, and if
 *  so what's the in-progress query? Slash mode is active exactly when the text starts with "/" AND
 *  the cursor sits inside the first whitespace-delimited token — so typing a space, or moving the
 *  cursor past it, closes the menu automatically with NO separate flag to keep in sync (the "open"
 *  state is entirely a function of `state`). `null` means "not in slash mode". Exported (not baked
 *  into the component) so T3's analogous "@"-file predicate can share this shape, and so it's
 *  independently testable. */
export function computeSlashQuery(state: InputState): string | null {
  const { text, cursor } = state;
  if (!text.startsWith("/")) return null;
  const firstWs = text.search(/\s/);
  const tokenEnd = firstWs === -1 ? text.length : firstWs;
  if (cursor < 1 || cursor > tokenEnd) return null;
  return text.slice(1, cursor);
}

/** Phase 3d T3 — the "@"-file mention analogue of `computeSlashQuery`, but with one deliberate
 *  difference: slash mode is anchored to the START OF THE WHOLE BUFFER (`text.startsWith("/")`)
 *  because a slash command only ever makes sense as the very first thing typed, while an "@"-file
 *  mention is meant to work ANYWHERE — "look at @src/foo" completes in place mid-sentence (the
 *  brief's explicit example). So instead of checking the whole buffer's prefix, this scans
 *  OUTWARD from the cursor to find the boundaries of whichever whitespace-delimited token the
 *  cursor currently sits in, and asks whether THAT token starts with "@". Because a token can only
 *  start with one character, a token beginning with "/" can never also open file mode here (and
 *  vice versa for `computeSlashQuery` on a non-first token, which it never even considers) — the
 *  two predicates are mutually exclusive by construction, so "@" and "/" can never both claim the
 *  same keystroke. Returns the token's start index (needed to replace exactly the "@query" span on
 *  completion — see `completeSelected` below) plus the in-progress query (the text from "@" to the
 *  cursor, mirroring `computeSlashQuery`'s "up to cursor, not to token end" contract so a cursor
 *  parked mid-token behaves the same way in both modes). `null` means "not in file mode". */
export function computeFileToken(state: InputState): { start: number; query: string } | null {
  const { text, cursor } = state;
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  if (text[start] !== "@") return null;
  if (cursor < start + 1) return null; // cursor sits before/at the "@" itself — not "inside" yet
  return { start, query: text.slice(start + 1, cursor) };
}

/** Convenience wrapper over `computeFileToken` for callers that only need the query string (the
 *  same shape `computeSlashQuery` exposes) — independently testable, same as that sibling. */
export function computeFileQuery(state: InputState): string | null {
  return computeFileToken(state)?.query ?? null;
}

export interface ComposerProps {
  running: boolean;
  policy: ApprovalPolicy;
  onSubmit: (text: string) => void;
  onSteer: (text: string) => void;
  onInterrupt: () => void;
  onCyclePolicy: () => void;
  disabled?: boolean;
  /** Injected clock (App's ticking `nowMs`) — the ONLY time source the double-esc-clear window
   *  uses; this component never calls `Date.now` itself. */
  nowMs: number;
  /** Scopes prompt history — "this session's entries first" (see `history-store.ts`). Optional;
   *  defaults to "" (the App threads through its real sessionId; tests may omit it entirely since
   *  the priority behavior itself is covered at the history-store level). */
  sessionId?: string;
  /** Injectable history file location (tests pass a temp path); defaults to `~/.norma/history.jsonl`. */
  historyPath?: string;
  /** Fires on the FIRST esc press against non-empty text ("Esc again to clear"); a later task wires
   *  this into the footer's hint line. Optional so existing call sites need no changes. */
  onHint?: (hint: string) => void;
  /** T5: fires on mount and every text/cursor edit, mirroring the internal `InputState` up to the
   *  parent — NOT a controlled-component wire (the parent never feeds a value back in). App.tsx
   *  uses this to (a) compute `bottomBarRows`' wrap-aware composer height from the SAME state Ink
   *  is about to lay out, on the SAME render pass, and (b) decide ctrl+D exit-eligibility ("only
   *  when the composer is empty"). Optional so every existing call site is unaffected. */
  onStateChange?: (state: InputState) => void;
  /** 3c whole-branch review item 2 (spec §5): Home/End pressed while the text is EMPTY call these
   *  (App wires them to transcript scroll-to-top / scroll-to-bottom) INSTEAD of the cursor ops the
   *  raw side-channel otherwise runs — the side-channel is the single consumer of those byte
   *  sequences, so routing here (not a second listener) keeps one owner per key. With any text in
   *  the buffer, Home/End keep their cursor semantics and these never fire. Optional: when omitted
   *  (legacy call sites/tests), empty-text Home/End fall through to the cursor ops as before
   *  (harmless no-ops on empty text). */
  onScrollTop?: () => void;
  onScrollBottom?: () => void;
  /** Phase 3d T2: the composer's Enter handler consults `parseSlashInput`/`COMMANDS` FIRST — a
   *  buffer that parses as a slash command NEVER reaches `onSubmit`/`onSteer` (it never goes to the
   *  model). App wires this to `runCommand(ctx, text)` (fire-and-forget; the runner's own note
   *  lands in the transcript asynchronously via `CommandCtx.appendNote`). Optional so legacy call
   *  sites without command support are unaffected (a slash-shaped buffer with no `onRunCommand`
   *  wired still clears/is "handled" — it just runs nothing).
   *
   *  Phase 3d T4: ALSO the callback the printable-input path below invokes with the literal string
   *  `"/help"` when "?" is typed against an EMPTY buffer (see that branch's doc) — the identical
   *  `runCommand` round-trip a typed `/help` + Enter would take, just a one-keystroke shortcut into
   *  it. Optional here too: with no `onRunCommand` wired, the "?" shortcut simply no-ops (same
   *  "runs nothing" fallback as an unwired slash command above) rather than falling through to
   *  insert — see that branch. */
  onRunCommand?: (text: string) => void;
  /** Phase 3d T2: fires on mount and every time the completion menu's VISIBLE row count changes —
   *  `min(6, filteredCount)` while open, `0` while closed — mirroring the same "push derived UI
   *  state up to the parent" convention `onStateChange` (T5) already uses. App.tsx needs this
   *  (rather than deriving it from the mirrored `InputState` alone) because Esc-dismissing the menu
   *  closes it WITHOUT changing `text`/`cursor` — a state.ts fact App can't observe any other way. */
  onMenuRowsChange?: (n: number) => void;
  /** Terminal width — feeds the completion menu's hard JS truncation (`completion-menu.tsx`'s file
   *  doc: never Yoga-wrap, so `bottomBarRows`' per-row budget stays exact). Defaults to 80, the same
   *  fallback `app.tsx`'s own `readCols` uses. */
  columns?: number;
  /** Phase 3d T3: the App-owned file index (see app.tsx's `fileIndexRef` doc) — `undefined` until
   *  the FIRST "@"-trigger's build resolves, a (possibly empty) array once it has. While
   *  `undefined` and the cursor is in an "@"-token, the menu shows the single disabled
   *  `INDEXING_LABEL` row instead of real matches (and every key gates as a zero-match query — see
   *  `fileOpen` below). Optional so every legacy call site (T1/T2 tests, any composer usage that
   *  never triggers file mode) is unaffected. */
  fileIndex?: string[];
  /** Phase 3d T3: fires the FIRST time the cursor lands in a fresh "@"-token this composer's whole
   *  lifetime (a `useRef` guard below ensures it's called at most once) — App wires this to kick
   *  off its one lazy `buildFileIndex` call (spec: "index built lazily on first @-trigger"). A
   *  no-op after the first call is fine even without the guard (App's own `fileIndexRef` is itself
   *  idempotent — see its doc), but guarding here too avoids a pointless extra call on every
   *  subsequent "@". Optional so legacy call sites are unaffected. */
  onNeedFileIndex?: () => void;
  /** child-transcript-view T3: when PROVIDED, an Esc pressed against an EMPTY buffer routes here
   *  and nothing else runs — App passes it ONLY while a child-transcript view is open, wiring it
   *  to "close the view, back to main". Presence-gated (same convention as `onScrollTop`/
   *  `onScrollBottom`'s empty-text Home/End routing above: one owner per key, chosen by the App).
   *  Deliberately checked BEFORE precedence #1's running-interrupt: closing an open child view
   *  outranks interrupting the MAIN turn on that keystroke — the footer's "esc to interrupt"
   *  applies to the main view the user is returning to, and interrupting a running main turn as a
   *  side effect of leaving a child view would be a destructive surprise. Empty-buffer-only: with
   *  text in the buffer every existing Esc rule (menu-close, running-interrupt, double-esc-clear)
   *  is byte-identical, provided or not (a menu can't even be open on an empty buffer — both
   *  predicates require text). Omitted → all Esc semantics exactly as before. */
  onEscEmpty?: () => void;
}

export function Composer({
  running,
  policy,
  onSubmit,
  onSteer,
  onInterrupt,
  onCyclePolicy,
  disabled,
  nowMs,
  sessionId = "",
  historyPath,
  onHint,
  onStateChange,
  onScrollTop,
  onScrollBottom,
  onRunCommand,
  onMenuRowsChange,
  columns = 80,
  fileIndex,
  onNeedFileIndex,
  onEscEmpty,
}: ComposerProps) {
  // `policy` stays a prop (callers/tests still pass it; `<Footer>`, a sibling, is the one that
  // renders it) — this component no longer renders it directly, matching `task-list.tsx`'s
  // `void nowMs;` convention for an intentionally-unused-here prop.
  void policy;
  const [state, setState] = useState<InputState>({ text: "", cursor: 0 });
  const [lastEscMs, setLastEscMs] = useState<number | null>(null);
  const effectiveHistoryPath = historyPath ?? defaultHistoryPath();

  // T5: mirror state up to the parent on mount + every edit (see the prop doc comment above).
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);

  // Load prompt history once per mount (the App never remounts a live composer, so "once" here
  // really does mean "for this composer's whole lifetime") — a lazy useState initializer, not an
  // effect, since there's no cleanup and no need to re-run on every render.
  const [historyEntries] = useState(() => loadHistory(effectiveHistoryPath, sessionId));
  const historyNav = useMemo(() => makeHistoryNav(historyEntries), [historyEntries]);

  // ---- Phase 3d T2/T3: completion menu state — slash-command menu (T2) AND "@"-file menu (T3),
  // sharing one selection/dismissal state machine. This is deliberate, not just economical: the two
  // predicates are mutually exclusive by construction (see `computeFileToken`'s doc — a token can
  // only start with ONE of "/" or "@", and slash mode only ever considers the first token) so at
  // most one of `rawSlashQuery`/`fileToken` is non-null on any given render — there's never a
  // moment where both menus could plausibly be "open" at once, so one shared `selected`/dismissal
  // pair (keyed on a mode-qualified string so switching FROM one mode TO the other always resets
  // it, even in the edge case where both queries happen to be the same string, e.g. both "") is
  // simpler than two parallel copies of the same bookkeeping.
  const rawSlashQuery = useMemo(() => computeSlashQuery(state), [state.text, state.cursor]);
  const fileToken = useMemo(() => computeFileToken(state), [state.text, state.cursor]);
  const rawFileQuery = fileToken?.query ?? null;
  const mode: "slash" | "file" | null = rawSlashQuery !== null ? "slash" : rawFileQuery !== null ? "file" : null;
  // `null` outside either mode; otherwise mode-qualified so a same-string transition between modes
  // (rare, but possible: e.g. an empty query in both) still counts as "changed" below.
  const menuKey = mode === "slash" ? `s:${rawSlashQuery}` : mode === "file" ? `f:${rawFileQuery}` : null;

  // `menuKey` is a PURE function of `state` (see `computeSlashQuery`/`computeFileToken`'s docs) — the
  // menu's "open" condition needs no separate flag to track in the common case. Esc, though, must be
  // able to dismiss the menu WITHOUT touching `text`/`cursor` (so text editing keeps working normally
  // while it stays shut) — `dismissedMenuKey` records exactly which key was last Esc-dismissed; the
  // moment `menuKey` changes to anything else (a new keystroke, or a mode switch), the "adjusting
  // state during render" block below clears it, reopening the menu automatically.
  const [dismissedMenuKey, setDismissedMenuKey] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const lastMenuKeyRef = useRef<string | null>(null);
  if (menuKey !== lastMenuKeyRef.current) {
    // React's sanctioned "adjust state during render when a derived value changes" pattern (guarded
    // so it only ever fires once per actual change, never loops): resets BOTH the Esc-dismissal and
    // the selection the instant the underlying query (or mode) changes, so the very next keystroke/
    // keypress already sees the corrected value — no extra render tick, unlike an effect.
    lastMenuKeyRef.current = menuKey;
    if (dismissedMenuKey !== null) setDismissedMenuKey(null);
    if (selected !== 0) setSelected(0);
  }

  const filtered = useMemo(() => (mode === "slash" ? filterCommands(rawSlashQuery!) : []), [mode, rawSlashQuery]);
  // T2 review item 2: a zero-match query (e.g. "/zzz") renders no menu, so it must not act like an
  // open one either — `filtered.length > 0` is part of the open condition itself, which makes the
  // key gating below (↑/↓/tab/esc) fall straight through to history nav / normal esc / etc. exactly
  // as if the user had never typed a slash.
  const slashOpen = mode === "slash" && dismissedMenuKey !== menuKey && filtered.length > 0;

  // Phase 3d T3: `fileIndex === undefined` means the App-owned build hasn't resolved yet (see the
  // prop doc) — `fileMatches` is simply empty until it has, which (per the T2 precedent just above)
  // makes `fileOpen` false too: the brief's explicit rule — "treat as zero matches for gating" while
  // indexing — falls out of this for free, with NO separate "is indexing" branch needed in the key
  // gating below. `fileIndexing` is tracked only for the RENDER decision (the placeholder row still
  // needs to appear even though it gates no keys).
  const fileIndexing = mode === "file" && fileIndex === undefined;
  const fileMatches = useMemo(
    () => (mode === "file" && fileIndex !== undefined ? fuzzyMatch(rawFileQuery ?? "", fileIndex) : []),
    [mode, rawFileQuery, fileIndex],
  );
  const fileOpen = mode === "file" && dismissedMenuKey !== menuKey && fileMatches.length > 0;

  // Phase 3d T3: the FIRST time the cursor lands in an "@"-token, tell the parent to start building
  // the index (see the `onNeedFileIndex` prop doc) — guarded so it fires at most once per composer
  // mount, no matter how many times the user re-enters file mode afterward.
  const firstFileTriggerRef = useRef(false);
  useEffect(() => {
    if (mode === "file" && !firstFileTriggerRef.current) {
      firstFileTriggerRef.current = true;
      onNeedFileIndex?.();
    }
  }, [mode, onNeedFileIndex]);

  const activeCount = mode === "slash" ? filtered.length : mode === "file" ? fileMatches.length : 0;
  const boundedSelected = activeCount > 0 ? Math.min(selected, activeCount - 1) : 0;
  // Whether the menu RENDERS at all — distinct from `slashOpen`/`fileOpen` (which gate keys): the
  // indexing placeholder renders with zero real matches, so it needs its own clause here. Esc does
  // NOT dismiss it specially — `fileIndexing` implies `fileOpen` is false, so the esc-dismiss gate
  // below never fires for it (the same "zero matches -> passthrough" rule applies to Esc too); the
  // `dismissedMenuKey !== menuKey` check here is the same defensive shape `slashOpen`/`fileOpen`
  // already use, kept for consistency even though nothing currently sets a dismissal while indexing.
  const menuVisible = slashOpen || fileOpen || (fileIndexing && dismissedMenuKey !== menuKey);
  const menuItems = useMemo(() => {
    if (mode === "slash") {
      return filtered.map((c) => ({ label: `/${c.name}${c.args ? ` ${c.args}` : ""}`, hint: c.description }));
    }
    if (mode === "file") {
      if (fileIndexing) return [{ label: INDEXING_LABEL }];
      // Label = relative path, no hint (per the brief — file matches carry no description).
      return fileMatches.map((p) => ({ label: p }));
    }
    return [];
  }, [mode, filtered, fileMatches, fileIndexing]);

  // Mirrors the menu's visible row count up to the parent (see the `onMenuRowsChange` prop doc) —
  // fires on mount too (same "T5" convention as the `onStateChange` effect above), including the
  // Esc-dismissed transition (which changes no `InputState` field app.tsx could otherwise observe).
  // Derived straight from `menuVisible`/`menuItems` (not `slashOpen`/`fileOpen` individually) so it
  // stays correct for the indexing placeholder too (one row, zero real matches).
  useEffect(() => {
    onMenuRowsChange?.(menuVisible ? Math.min(MAX_MENU_ROWS, menuItems.length) : 0);
  }, [menuVisible, menuItems.length, onMenuRowsChange]);

  // Tab AND the "enter completes a partial" case share this: fill the buffer with the selected
  // command's full name (`/name args` gets a trailing space so the cursor lands ready to type an
  // arg; a no-arg command doesn't — the cursor sitting right after the name with no space keeps the
  // menu OPEN, since `computeSlashQuery` still sees the cursor inside the first token) — OR, in file
  // mode, replace exactly the "@query" span (`fileToken.start` up to the CURRENT cursor, per
  // `computeFileToken`'s doc) with the selected path plus a trailing space, preserving whatever came
  // before the "@" and whatever sits at/after the cursor (mid-text "@" — the brief's explicit "look
  // at @src/tui/ap" example). A no-op when there's nothing filtered to complete to.
  function completeSelected(): void {
    if (mode === "slash") {
      const cmd = filtered[boundedSelected];
      if (!cmd) return;
      const newText = `/${cmd.name}${cmd.args ? " " : ""}`;
      setState({ text: newText, cursor: newText.length });
      return;
    }
    if (mode === "file" && fileToken) {
      const path = fileMatches[boundedSelected];
      if (!path) return;
      const before = state.text.slice(0, fileToken.start);
      const after = state.text.slice(state.cursor);
      const inserted = `${path} `;
      setState({ text: before + inserted + after, cursor: before.length + inserted.length });
    }
  }

  // Whole-branch review item 2: the raw side-channel handler below runs from a closure created when
  // its effect last wired (its deps deliberately exclude `state`), so it reads text-emptiness at
  // EVENT time through a render-updated ref — the same event-time-read pattern app.tsx uses for its
  // viewport refs — rather than a stale closure snapshot.
  const textEmptyRef = useRef(state.text.length === 0);
  textEmptyRef.current = state.text.length === 0;

  // T3 raw side-channel (see the file-top doc comment) — Home/End/Backspace/Forward-Delete only.
  // Home/End route to the App's transcript scroll callbacks when the text is EMPTY (spec §5; see the
  // onScrollTop/onScrollBottom prop doc), and to their cursor ops otherwise.
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    if (disabled || !internal_eventEmitter) return;
    const onRawInput = (chunk: Buffer | string) => {
      const seq = typeof chunk === "string" ? chunk : chunk.toString();
      if (HOME_SEQS.has(seq)) {
        if (textEmptyRef.current && onScrollTop) { onScrollTop(); return; }
        setState(home);
        return;
      }
      if (END_SEQS.has(seq)) {
        if (textEmptyRef.current && onScrollBottom) { onScrollBottom(); return; }
        setState(end);
        return;
      }
      if (BACKSPACE_SEQS.has(seq)) { setState(backspace); return; }
      if (DELETE_SEQS.has(seq)) { setState(del); return; }
    };
    internal_eventEmitter.on("input", onRawInput);
    return () => { internal_eventEmitter.off("input", onRawInput); };
  }, [disabled, internal_eventEmitter, onScrollTop, onScrollBottom]);

  useInput(
    (input, key) => {
      // Ink-key → decodeKey's enum adapter (ambiguity resolution #1).
      const k = key.escape
        ? "esc"
        : key.tab && key.shift
          ? "shiftTab"
          : key.return
            ? "enter"
            : key.upArrow
              ? "up"
              : key.downArrow
                ? "down"
                : "other";
      const action = footerKeyAction(k, NO_FOOTER_FOCUS, []);
      if (action.kind === "cyclePolicy") {
        onCyclePolicy();
        return;
      }

      // ---- Phase 3d T2/T3: menu key gating — the SINGLE actor for ↑/↓/tab/esc while EITHER menu is
      // open (history nav below, and the esc/double-esc state machine that follows, never also see
      // these same keystrokes while `slashOpen || fileOpen` — the binding "one actor per key" rule).
      // `slashOpen`/`fileOpen` are mutually exclusive (see the state block's doc), so this never
      // double-handles a single keystroke against two different match lists. Plain Enter deliberately
      // falls through to the unified handler further down FOR SLASH MODE — it needs the exact same
      // known-command/partial-match decision whether or not the menu happens to still be open — but
      // FILE mode has no "run it anyway" equivalent (an "@path" mention isn't a runnable command), so
      // Enter completes right here whenever `fileOpen` (never falls through to onSubmit/onSteer): the
      // brief's explicit "enter on file mode NEVER submits/runs" rule, scoped to the case where a real
      // match exists — a zero-match/still-indexing "@query" is NOT `fileOpen`, so Enter correctly
      // passes through to the normal submit path in that case (same "zero matches -> passthrough" rule
      // as everything else here).
      if (slashOpen || fileOpen) {
        if (k === "esc" && !running) {
          // "esc closes the menu ONLY" — no double-esc bookkeeping (`lastEscMs`/`onHint`) runs.
          // Gated on `!running` (T2 review item 1): precedence #1 below — a running turn always
          // interrupts on the FIRST esc, the 3a invariant — outranks menu-close, so while a turn
          // runs this branch steps aside and esc falls through to the `onInterrupt` path.
          setDismissedMenuKey(menuKey);
          return;
        }
        if (k === "up") {
          setSelected((sel) => {
            const bounded = activeCount > 0 ? Math.min(sel, activeCount - 1) : 0;
            return Math.max(0, bounded - 1);
          });
          return;
        }
        if (k === "down") {
          setSelected((sel) => {
            const bounded = activeCount > 0 ? Math.min(sel, activeCount - 1) : 0;
            return activeCount > 0 ? Math.min(activeCount - 1, bounded + 1) : 0;
          });
          return;
        }
        if (key.tab && !key.shift) {
          completeSelected();
          return;
        }
        if (k === "enter" && fileOpen) {
          completeSelected();
          return;
        }
      }

      if (k === "esc") {
        // Precedence #0 (child-transcript-view T3): an EMPTY buffer with `onEscEmpty` provided
        // (App passes it only while a child-transcript view is open) routes the whole keystroke
        // there — see the prop's doc comment for why this deliberately outranks the running-
        // interrupt below. Never taken with text in the buffer (or when the prop is absent), so
        // every pre-existing Esc rule is byte-identical outside an open child view.
        if (state.text.length === 0 && onEscEmpty) {
          onEscEmpty();
          return;
        }
        // Precedence #1 (UNCHANGED from 3a/3b): a running turn always interrupts on Esc, no matter
        // what's in the buffer.
        if (running) {
          onInterrupt();
          return;
        }
        // Precedence #2: idle + empty text — Esc stays inert (legacy idle-Esc parity, per app.tsx).
        if (state.text.length === 0) return;
        // Precedence #3: idle + non-empty text — double-esc-to-clear, timed off the `nowMs` prop
        // (never Date.now here).
        if (lastEscMs !== null && nowMs - lastEscMs <= DOUBLE_ESC_WINDOW_MS) {
          appendHistory(effectiveHistoryPath, { display: state.text, ts: nowMs, sessionId });
          setState({ text: "", cursor: 0 });
          setLastEscMs(null);
        } else {
          onHint?.("Esc again to clear");
          setLastEscMs(nowMs);
        }
        return;
      }

      if (k === "enter") {
        if (state.text.length === 0) return; // never submit/steer/run an empty buffer
        const text = state.text;
        // Phase 3d T2: the slash-command check runs FIRST — a buffer that parses as a slash
        // command never reaches onSubmit/onSteer (it never goes to the model).
        const parsed = parseSlashInput(text);
        if (parsed !== null) {
          const isKnown = COMMANDS.some((c) => c.name === parsed.cmd);
          if (!isKnown && slashOpen) {
            // A "/partial" matching the currently-selected menu item -> complete it (exactly like
            // Tab), never run. (`slashOpen` already implies `filtered.length > 0` — review item 2.)
            completeSelected();
            return;
          }
          // A known command (with or without args), OR an unknown command with the menu already
          // closed (cursor past the first token) -> run it. `runCommand` (commands.ts, called by
          // App's onRunCommand) is what actually tells known from unknown and produces the
          // "Unknown command" note — this composer only decides WHETHER to run vs. complete.
          onRunCommand?.(text);
          appendHistory(effectiveHistoryPath, { display: text, ts: nowMs, sessionId });
          setState({ text: "", cursor: 0 });
          setLastEscMs(null);
          return;
        }
        if (running) onSteer(text);
        else onSubmit(text);
        appendHistory(effectiveHistoryPath, { display: text, ts: nowMs, sessionId });
        setState({ text: "", cursor: 0 });
        setLastEscMs(null); // a fresh line resets the double-esc window
        return;
      }

      if (k === "up") {
        const recalled = historyNav.up(state.text);
        if (recalled !== null) setState({ text: recalled, cursor: recalled.length });
        return;
      }
      if (k === "down") {
        const recalled = historyNav.down();
        if (recalled !== null) setState({ text: recalled, cursor: recalled.length });
        return;
      }

      if (key.ctrl && input === "a") { setState(home); return; }
      if (key.ctrl && input === "e") { setState(end); return; }
      if (key.leftArrow) { setState(key.ctrl || key.meta ? wordLeft : left); return; }
      if (key.rightArrow) { setState(key.ctrl || key.meta ? wordRight : right); return; }

      // Phase 3d T4: "?" typed against an EMPTY buffer surfaces help instead of inserting — the
      // single actor for this keystroke, composer-internal and BEFORE the generic insert path
      // below (never a second App-level consumer). Gated on `input === "?"` EXACTLY (not
      // `.includes`/`.startsWith`) so a multi-char paste that happens to contain "?" (Ink delivers
      // a whole paste as ONE `input` string — see the doc below) types normally; only a genuine
      // single "?" keystroke matches. A NON-empty buffer falls straight through to the ordinary
      // insert path, so "?" types like any other character once there's text already.
      if (input === "?" && state.text.length === 0 && !key.ctrl && !key.meta) {
        onRunCommand?.("/help");
        return;
      }

      // Plain printable input (a single char, or a whole pasted string delivered as one event —
      // Ink's own doc for useInput). Backspace/Delete/Home/End never reach here — Ink forces
      // `input` to "" for all four (see the T3 doc comment above) — and ctrl/meta combos with no
      // dedicated branch above carry no printable text of their own (e.g. ctrl+c arrives as input
      // "c", key.ctrl true), so they stay excluded from the buffer.
      //
      // TUI renderer T1 — mouse bytes are refused HERE, before the insert fallback, not only at
      // app.tsx's emitter patch: Ink's use-input strips one leading ESC and hands a full SGR
      // report to every useInput consumer as the printable string "[<64;116;23M" (ctrl/meta both
      // false), which this fallback used to type into the buffer — the user-reported
      // wheel-into-composer leak. The emitter patch is a SEPARATE consumer bolted beside Ink's
      // parser; whatever ever reaches this component (a report forwarded by an unpatched path, or
      // the continuation of a report split inside its ESC prefix) must die at the input layer's
      // last exit. `isMouseArtifact` swallows only whole-string mouse debris; a raw interior ESC
      // (never producible by typing — Ink strips the one leading ESC and real keys parse to named
      // keys) is refused on the same "unknown CSI never becomes text" rule.
      if (input && !key.ctrl && !key.meta) {
        if (isMouseArtifact(input) || input.includes("\x1b")) return;
        setState((s) => insert(s, input));
      }
    },
    { isActive: !disabled },
  );

  const { before, at, after } = renderWithCursor(state);

  return (
    <>
      {/* Phase 3d T2/T3: the completion menu renders ABOVE the open-rule box, never inside it —
       *  it's no part of the bordered composer's own single-root-Text layout (see the render note
       *  below), just a sibling that appears/disappears above it. `menuVisible` (not `slashOpen`
       *  alone) covers the T3 indexing placeholder, which renders with zero real matches. */}
      {menuVisible ? <CompletionMenu items={menuItems} selected={boundedSelected} columns={columns} /> : null}
      <Box
        borderStyle="round"
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
        borderColor={theme.promptBorder}
        width="100%"
      >
        {/* ONE root <Text> with exactly ONE nested <Text> (the inverse cursor) — not two sibling
         *  Text nodes (the 3a/3b shape: a separate dimColor prompt Text next to a separate buffer
         *  Text). Ink v5.2.1's Yoga-backed layout mismeasures a bordered, width:100% Box's row on
         *  the FIRST render where MORE THAN ONE Text descendant has independent style/content
         *  (reproduced in isolation: 2 sibling Texts, or 1 root + 2 nested children, both glitch —
         *  garbled/truncated text, sometimes bleeding into the border row; 1 root + 1 nested child
         *  never does). To keep the reference behavior — ONLY the "❯ " glyph dims while a turn runs,
         *  never the user's typed text — the glyph's dim is baked into the root STRING as raw ANSI
         *  codes (`ansi.dim`, the module-level Chalk instance) instead of a styled <Text> child that
         *  would re-trigger the bug. Ink measures text width ANSI-aware (string-width), so the baked
         *  codes don't skew layout; verified clean on the bug's trigger case (first content frame
         *  after empty) in composer.test.tsx (n). */}
        <Text>
          {`${running ? ansi.dim("❯ ") : "❯ "}${before}`}
          <Text inverse>{at || " "}</Text>
          {after}
        </Text>
      </Box>
    </>
  );
}
