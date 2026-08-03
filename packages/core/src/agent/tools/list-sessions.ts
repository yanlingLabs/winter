import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { ActivityDeriver } from "../../sessions/activity";
import { participatesInActivity } from "../../sessions/activity";
import { setSessionActivity, type SetActivityDeps } from "../../sessions/set-activity";
import type { SessionRow } from "../../sessions/store";

/** Rows shown in one answer. A hard cap rather than a paging cursor: this is a coordinator's
 *  situational-awareness listing, not a database view — and the caps below are stated in the tool
 *  description so narrowing (cwd/type/keywords) is a choice the model makes knowingly. The overflow
 *  is ALWAYS reported ("N more matched"); silent truncation of a management listing is how a
 *  coordinator concludes a session doesn't exist. */
export const LIST_SESSIONS_MAX_ROWS = 50;

/** Bytes of ONE session's transcript a `keywords` scan may read: the first and last half of this,
 *  so a match near the start OR the end of a long session is still found (the cleaner's own
 *  head+tail sampling, for the same reason — those are the two ends that carry the substance). */
export const KEYWORD_SCAN_BYTES_PER_SESSION = 128 * 1024;

/** Bytes a SINGLE `list_sessions` call may read across all sessions. Sessions are scanned
 *  most-recent-first, so the budget is spent where a coordinator is most likely to be looking; when
 *  it runs out the answer SAYS how many sessions went unscanned rather than pretending they didn't
 *  match. */
export const KEYWORD_SCAN_BYTES_TOTAL = 8 * 1024 * 1024;

/** Default `maxDepth` — how many directory levels BELOW `cwd` still count as a match. Deep enough
 *  that "under my project" means what a human means by it, finite so a `cwd` of `/` can't be used
 *  to fan a keyword scan across the entire session store by accident. */
export const DEFAULT_MAX_DEPTH = 20;

export const LIST_SESSIONS_TOOL = "list_sessions";
export const MANAGE_SESSION_TOOL = "manage_session";

/** `manage_session`'s `stop` refusal for a non-participating session. Deliberately its OWN sentence,
 *  not the shared `ACTIVITY_MODE_REFUSAL` ("activity states apply to...") — `stop` sets no activity
 *  state, so that wording would describe a thing this verb never does. Exported so the covering test
 *  pins the same string production answers with, rather than a second hand-copy. */
export const STOP_MODE_REFUSAL = "stop applies to code and cowork sessions only";

/** The read slice of `SessionStore` this tool needs — a narrow structural interface (the
 *  `ReaperStore`/`CleanerStore` precedent) so tests drive it without a live daemon. */
export interface ListSessionsStore {
  list(): SessionRow[];
  lastEventTs(sessionId: string): number;
  transcriptPath(sessionId: string): string;
}

export interface ListSessionsDeps {
  store: ListSessionsStore;
  /** THE activity derivation — `makeActivityDeriver`'s output, in production the very function
   *  `session.list` stamps its rows with (published by `startIpcServer`). Not rebuilt here: a
   *  management surface that derives state its own way is a second answer to one question. */
  derive: ActivityDeriver;
  /** `AgentEngine.turnStartedAt` — present only while a turn is actually running. */
  turnStartedAt(sessionId: string): number | undefined;
  /** Injectable clock (the `ReaperDeps.now`/`CleanerDeps.now` precedent). */
  now?: () => number;
  /** Keyword-scan budgets, overridable ONLY so tests can exercise the exhausted-budget answer
   *  without writing megabytes of fixture transcripts (the `ReaperDeps.now` precedent: a knob that
   *  exists to make a real behaviour observable, not a setting). Production passes neither. */
  scanBytesPerSession?: number;
  scanBytesTotal?: number;
}

export interface ManageSessionDeps extends SetActivityDeps {
  /** `AgentEngine.interrupt` — the SAME abort `session.interrupt` and T5's last-detach enforcement
   *  use, so a turn stopped by the coordinator ends exactly as a user's ESC ends it
   *  (`turn_completed(aborted)`, resumable), with no second abort mechanism to keep in step. */
  interrupt(sessionId: string): void;
  /** `AgentEngine.isRunning` — read for the "nothing to stop" answer. Inherited from
   *  `SetActivityDeps`; named here only because `stop` reads it directly too. */
  isRunning(sessionId: string): boolean;
}

/** `~` expansion + canonicalization, mirroring `agent/memory-dir.ts`'s own `expandTilde`/`canon`
 *  pair (realpath when the directory exists, plain `resolve` when it does not — a session's cwd is
 *  a model-supplied project directory that may well be gone). Both sides of every comparison go
 *  through this, which is what makes trailing slashes, `..` segments and symlinked project roots
 *  compare equal instead of nearly-equal. */
function canonDir(p: string): string {
  const expanded = p === "~" ? homedir()
    : p.startsWith("~/") || p.startsWith(`~${sep}`) ? join(homedir(), p.slice(2))
    : p;
  try { return realpathSync(expanded); }
  catch { return resolve(expanded); }
}

/** Directory levels of `child` BELOW `base`: 0 when they are the same directory, `undefined` when
 *  `child` is not under `base` at all. */
function depthUnder(base: string, child: string): number | undefined {
  const rel = relative(base, child);
  if (rel === "") return 0;
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).length;
}

/** Seconds, the `agent_list`/`agent_output` convention for elapsed time (`elapsed ${n}s`) — one
 *  vocabulary for "how long has this been going" across every surface that shows it. */
function elapsedS(fromMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - fromMs) / 1000));
}

/** Reads at most `KEYWORD_SCAN_BYTES_PER_SESSION` of a transcript — the whole file when it fits,
 *  otherwise its head and tail halves. Returns `""` for anything unreadable (a log not yet flushed,
 *  a file removed under us): a scan failure must narrow the answer, never throw the listing away.
 *
 *  THE TEXT THIS RETURNS NEVER REACHES THE MODEL, and must not start to. A session JSONL is the
 *  sole sink for provider `encrypted_content` / `reasoning_item.itemJson` (CLAUDE.md: never log it,
 *  never write it into a model-readable transcript) — this samples those raw bytes to answer a
 *  yes/no `includes` question and nothing else. Adding a "matching excerpt" to the tool's output
 *  would pipe opaque provider state straight into another model's context. Match on it; never
 *  quote it. */
function sampleTranscript(path: string, budget: number): { text: string; bytes: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    if (size <= budget) {
      const buf = Buffer.allocUnsafe(size);
      const n = readSync(fd, buf, 0, size, 0);
      return { text: buf.toString("utf8", 0, n), bytes: n };
    }
    const half = Math.floor(budget / 2);
    const head = Buffer.allocUnsafe(half);
    const headN = readSync(fd, head, 0, half, 0);
    const tail = Buffer.allocUnsafe(half);
    const tailN = readSync(fd, tail, 0, half, size - half);
    return { text: head.toString("utf8", 0, headN) + "\n" + tail.toString("utf8", 0, tailN), bytes: headN + tailN };
  } catch {
    return { text: "", bytes: 0 };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

const ListSessionsArgs = z.object({
  type: z.enum(["background", "active", "idle", "archived", "all"]).optional(),
  cwd: z.string().min(1).optional(),
  maxDepth: z.number().int().min(0).optional(),
  keywords: z.string().min(1).optional(),
});

const ManageSessionArgs = z.object({
  sessionId: z.string().min(1),
  action: z.enum(["stop", "background", "archive", "resume"]),
});

/**
 * session-activity-hygiene T8: dispatch's MANAGEMENT surface over the session lifecycle T1-T7 built.
 *
 * Two tools, both `modes: ["dispatch"]` (the per-mode registry's single declaration site — a tool
 * with no `modes` is code-only, so this is the deliberate opt-in):
 *
 *   * `list_sessions` — the read. What exists, what state each session is in, where it works, and
 *     how long the running ones have been running.
 *   * `manage_session` — the write. stop / background / archive / resume, with EXACTLY
 *     `session.setActivity`'s semantics because it calls `session.setActivity`'s own implementation
 *     (`setSessionActivity`), not a second copy of its rules.
 *
 * Chat and dispatch sessions never appear and can never be managed: they do not participate in the
 * lifecycle at all (activity.ts's ACTIVITY_MODES allowlist), so there is nothing here to show or
 * set — including the coordinator's own session, which is why `manage_session` cannot be turned on
 * its caller.
 */
export function registerListSessionsTools(
  r: ToolRegistry,
  deps: ListSessionsDeps & ManageSessionDeps,
): void {
  const now = deps.now ?? (() => Date.now());

  r.register({
    name: LIST_SESSIONS_TOOL,
    modes: ["dispatch"],
    // dispatch-tool-deferral: `true` unconditionally (the agent_list/agent_output precedent, not a
    // caller-supplied flag like task_stop's/computer's `deferred: ["dispatch"]`) — dispatch is the
    // ONLY mode this tool is ever eligible for, so `true` and `["dispatch"]` mean the same thing
    // here; `true` says that plainly instead of naming a one-element array. Loaded via ToolSearch
    // like the rest of dispatch's control surface (bash/task_stop/computer/AskQuestion/send_message).
    deferred: true,
    description: [
      "List the work sessions on this Mac — code and cowork sessions only (chat and the dispatch session itself never appear).",
      "Each row: session id, mode, working directory, title, transcript file, and how long its turn has been running when one is.",
      `type: filter by lifecycle state — background | active | idle | archived | all (default all; the state column is shown for "all" only).`,
      "cwd: only sessions working AT or UNDER this directory.",
      `maxDepth: how many directory levels below cwd still count (default ${DEFAULT_MAX_DEPTH}).`,
      `keywords: only sessions whose transcript contains ALL of these whitespace-separated words (case-insensitive).`,
      `The keyword scan is BOUNDED: at most ${Math.round(KEYWORD_SCAN_BYTES_PER_SESSION / 1024)}KB per session (its first and last halves) and`,
      `${Math.round(KEYWORD_SCAN_BYTES_TOTAL / 1024 / 1024)}MB per call, newest sessions first — the answer says how many sessions went unscanned if that budget runs out.`,
      `At most ${LIST_SESSIONS_MAX_ROWS} rows are shown; the count of further matches is always reported.`,
      "Manage what you find with manage_session; message one with send_message.",
    ].join(" "),
    args: ListSessionsArgs,
    run(args: z.infer<typeof ListSessionsArgs>) {
      const type = args.type ?? "all";
      const at = now();
      const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
      const base = args.cwd !== undefined ? canonDir(args.cwd) : undefined;

      // 1. Participation: chat/dispatch rows are not part of this lifecycle and never appear.
      //    `derive` returns undefined for them anyway; filtering FIRST keeps them out of the
      //    keyword scan's budget too.
      const rows = deps.store.list().filter((s) => participatesInActivity(s.mode));

      // 2. State — derived once per row against ONE instant, so two rows in one answer can never
      //    straddle the same 24h demotion boundary (activityFor's own contract).
      let cand = rows.map((s) => ({ row: s, activity: deps.derive(s, s.sessionId, at) }));
      if (type !== "all") cand = cand.filter((c) => c.activity === type);

      // 3. Directory: AT or UNDER `cwd`, no deeper than maxDepth levels below it. A session with no
      //    recorded cwd can never match a directory filter (there is nothing to compare).
      if (base !== undefined) {
        cand = cand.filter((c) => {
          if (!c.row.cwd) return false;
          const d = depthUnder(base, canonDir(c.row.cwd));
          return d !== undefined && d <= maxDepth;
        });
      }

      // 4. Newest first — the order a coordinator wants, AND the order the keyword budget below is
      //    spent in (most recent gets scanned first).
      const withTs = cand.map((c) => ({ ...c, lastEventTs: deps.store.lastEventTs(c.row.sessionId) }));
      withTs.sort((a, b) => b.lastEventTs - a.lastEventTs);

      // 5. Keywords: a bounded grep. Both caps are reported rather than silently applied.
      let unscanned = 0;
      let matched = withTs;
      if (args.keywords !== undefined) {
        const perSession = deps.scanBytesPerSession ?? KEYWORD_SCAN_BYTES_PER_SESSION;
        const totalBudget = deps.scanBytesTotal ?? KEYWORD_SCAN_BYTES_TOTAL;
        const terms = args.keywords.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
        let spent = 0;
        const hits: typeof withTs = [];
        for (const c of withTs) {
          // A GRANTED budget below the per-session cap (including the exhausted 0 case) is treated
          // as unscanned outright rather than sampled — a degenerate residual (e.g. 1 byte) makes
          // `sampleTranscript`'s head/tail halves floor to 0 and read nothing, which then reported a
          // clean non-match forever without `spent` ever advancing to end the loop honestly.
          const budget = Math.min(perSession, totalBudget - spent);
          if (budget < perSession) { unscanned++; continue; }
          const { text, bytes } = sampleTranscript(deps.store.transcriptPath(c.row.sessionId), budget);
          spent += bytes;
          const hay = text.toLowerCase();
          if (terms.every((t) => hay.includes(t))) hits.push(c);
        }
        matched = hits;
      }

      if (matched.length === 0) {
        return unscanned > 0
          ? `no sessions matched — ${unscanned} were not scanned (keyword budget spent); narrow with cwd or type`
          : "no sessions matched";
      }

      const shown = matched.slice(0, LIST_SESSIONS_MAX_ROWS);
      const lines = shown.map((c) => {
        const parts = [c.row.sessionId];
        // The state column is for `type: "all"` only — under a filter every row has the state that
        // was asked for, and repeating it is noise.
        if (type === "all") parts.push(c.activity ?? "unknown");
        parts.push(c.row.mode ?? "code");
        const startedAt = deps.turnStartedAt(c.row.sessionId);
        if (startedAt !== undefined) parts.push(`running ${elapsedS(startedAt, at)}s`);
        parts.push(`cwd ${c.row.cwd ?? "(none)"}`);
        if (c.row.title) parts.push(`"${c.row.title}"`);
        parts.push(deps.store.transcriptPath(c.row.sessionId));
        return parts.join(" | ");
      });

      const header = matched.length > shown.length
        ? `${shown.length} sessions (${matched.length - shown.length} more matched — narrow with cwd, type or keywords)`
        : `${shown.length} session${shown.length === 1 ? "" : "s"}`;
      const footer = unscanned > 0
        ? `\n${unscanned} sessions were not scanned for keywords (budget spent) — narrow with cwd or type to reach them.`
        : "";
      return `${header}\n${lines.join("\n")}${footer}\nManage one with manage_session (stop/background/archive/resume); message one with send_message.`;
    },
  });

  r.register({
    name: MANAGE_SESSION_TOOL,
    modes: ["dispatch"],
    // dispatch-tool-deferral: see LIST_SESSIONS_TOOL's registration above — same reasoning, same
    // unconditional `true` (dispatch-only tool, so `true` and `["dispatch"]` coincide).
    deferred: true,
    description: [
      "Change a code or cowork session's lifecycle state, or stop the turn it is running. Find sessions with list_sessions.",
      "action: stop — take it off duty: abort the running turn (the same abort the user's ESC performs; the session stays resumable) AND clear its background flag, even when no turn is running.",
      "background — keep it running unattended.",
      "archive — hide it under the archived tab; refused while a turn is running (stop or background it first).",
      "resume — un-archive it; a session that was backgrounded comes back backgrounded.",
      "Every change is announced live to the user's open windows. An ARCHIVED session is what the user hid: resume is the only way to change it — background and stop leave its flags alone, and a message can never resurrect it.",
    ].join(" "),
    args: ManageSessionArgs,
    run(args: z.infer<typeof ManageSessionArgs>) {
      const { sessionId, action } = args;
      if (action === "stop") {
        // Read the row FIRST: an unknown session must answer "unknown" (store.meta throws, and
        // registry.execute turns a throw into the isError outcome), not "nothing to stop". The
        // participation rule is the same one every other door applies — it is what keeps the
        // coordinator from aborting its own turn, or a chat session's.
        const meta = deps.store.meta(sessionId);
        // Its OWN refusal, not `ACTIVITY_MODE_REFUSAL`: stop sets no activity state, so the shared
        // "activity states apply to..." sentence would describe a thing this verb never does.
        if (!participatesInActivity(meta.mode)) throw new Error(STOP_MODE_REFUSAL);
        // activity-verb-semantics ruling 4a: A FLEET STOP DECOMMISSIONS. Aborting the turn is only
        // half of what a coordinator means by "stop this worker" — the other half is that it stops
        // being a background session at all, which is why the flag is cleared EVEN WHEN NO TURN IS
        // RUNNING (a flagged-but-idle worker is still on duty). ESC / `session.interrupt` are
        // deliberately untouched: pausing a session you are sitting in front of is not the same act.
        const wasRunning = deps.isRunning(sessionId);
        if (wasRunning) deps.interrupt(sessionId);
        // Ruling 1 binds this verb too: an ARCHIVED session's flags are not the coordinator's to
        // move — resume is the only door. Archived ∧ running is unreachable (the archive door
        // refuses a running turn), so the interrupt above is defensive, and this branch is simply
        // "mutate nothing, say something honest". Returned rather than thrown: nothing failed, there
        // was nothing here to stop.
        if (meta.archived) {
          return wasRunning
            ? `stopped the running turn in session '${sessionId}' — it stays resumable; it is archived, so its flags are untouched (resume it first to manage it)`
            : `session '${sessionId}' is archived — no turn was running, and an archived session's flags stay untouched until it is resumed`;
        }
        // ONE WRITER. The flag goes through the shared state machine, not `store.setBackgrounded`,
        // so the change reaches every open window on the SAME emission path as `background`/
        // `archive`/`resume` — a hand-written flag write here would desync any UI showing this
        // session until its next `session.list`. Run unconditionally (an unflagged session's write
        // is a no-op and `SessionHub.emitActivity` suppresses the restatement) so there is no
        // branch in which this tool becomes a second writer.
        const res = setSessionActivity(deps, sessionId, "unbackground");
        if (!res.ok) throw new Error(res.error);
        if (wasRunning) {
          return `stopped the running turn in session '${sessionId}' — it stays resumable; it is now ${res.activity}`;
        }
        // The notice SAYS WHAT IT DID. "nothing to stop" on a session that just came off background
        // duty would hide the very change the coordinator asked for.
        if (meta.backgrounded) {
          return `session '${sessionId}': no turn was running; cleared its background flag — it is now ${res.activity}`;
        }
        return `session '${sessionId}' has no turn running — nothing to stop`;
      }
      const target = action === "background" ? "background" : action === "archive" ? "archived" : null;
      const res = setSessionActivity(deps, sessionId, target);
      // A refusal is a tool ERROR (throw → registry.execute wraps it as isError) so the model cannot
      // read it as a completed change; the wording is `session.setActivity`'s own, because it IS
      // `session.setActivity`'s own — same function, same rules.
      if (!res.ok) throw new Error(res.error);
      return `session '${sessionId}' is now ${res.activity}`;
    },
  });
}
