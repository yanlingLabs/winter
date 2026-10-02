import { z } from "zod";
import type { ToolDefinition, ToolRegistry } from "./registry";
import type { Activity, ActivityDeriver } from "../../sessions/activity";
import { participatesInActivity } from "../../sessions/activity";
import type { SessionRow } from "../../sessions/store";
import { parseSessionQuery, rankSessions, type QueryableSession } from "../../sessions/session-query";

/** Rows the DEFAULT listing shows at most; the rest is always reported as a count. */
export const LIST_SESSIONS_MAX_ROWS = 50;
/** Rows a `query` answers with at most (best first); the rest is reported as a count. */
export const LIST_SESSIONS_QUERY_MAX_ROWS = 10;
/** Inactive Dispatch-spawned sessions the default listing shows (as `completed`): the newest few only. */
export const LIST_SESSIONS_RECENT_COMPLETED_CHILDREN = 4;

export const LIST_SESSIONS_TOOL = "list_sessions";

/** The read slice of `SessionStore` this tool needs — a narrow structural interface (the
 *  `ReaperStore`/`CleanerStore` precedent) so tests drive it without a live daemon. */
export interface ListSessionsStore {
  list(): SessionRow[];
  lastEventTs(sessionId: string): number;
  transcriptPath(sessionId: string): string;
  /** The files the session edited (the store's edited-files index), most recent first. */
  editedFiles(sessionId: string): string[];
  /** The session's first main-thread user message, as indexed. */
  firstMessage(sessionId: string): string | undefined;
  /** The one-time edited-files backfill (run before the first query if boot has not done it yet). */
  editedFilesBackfilled?(): boolean;
  backfillEditedFiles?(): number;
}

export interface ListSessionsDeps {
  store: ListSessionsStore;
  /** THE activity derivation — `makeActivityDeriver`'s output, in production the very function
   *  `session.list` stamps its rows with (published by `startIpcServer`). Not rebuilt here: a
   *  management surface that derives state its own way is a second answer to one question. */
  derive: ActivityDeriver;
  /** The session's running turn's start — present only while a turn is actually running. */
  turnStartedAt(sessionId: string): number | undefined;
  /** THE `working` signal (`makeSessionSignalsDeriver`: a turn or background work). Absent: a running turn. */
  working?(sessionId: string): boolean;
  /** Injectable clock (the `ReaperDeps.now`/`CleanerDeps.now` precedent). */
  now?: () => number;
}

/** Seconds, the `agent_list`/`agent_output` convention for elapsed time. */
function elapsedS(fromMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - fromMs) / 1000));
}

const ListSessionsArgs = z.object({
  query: z.string().min(1).max(500).optional(),
});

/** What a row's state column says: the lifecycle label, except an IDLE Dispatch-spawned session, which is
 *  a finished delegated task — `completed`. */
function stateOf(row: SessionRow, activity: Activity | undefined): string {
  if (activity === "idle" && row.origin === "dispatch-child") return "completed";
  return activity ?? "unknown";
}

/**
 * Dispatch's read of the sessions on this Mac (user ruling 2026-10-02, rebuilt). Only `list_sessions`:
 * `manage_session` was REMOVED from Dispatch the same day (stop a session's turn with `TaskStop`, message or
 * resume one with `SendMessage`).
 *
 *   * DEFAULT — what is going on now: every ACTIVE and every BACKGROUND code/Cowork session (the
 *     `session.list` derivation), plus Dispatch's own spawned sessions — an inactive one shows as
 *     `completed`, and only the newest four of those. Idle and archived sessions are not listed; their
 *     count is.
 *   * `query` — free-form ("the session that edited ~/projects/winter/config.toml", "the login fix from
 *     yesterday"): interpreted by `sessions/session-query.ts` (dates, paths against the files a session
 *     EDITED and its cwd, words against title / first message / cwd) across ALL code/Cowork sessions,
 *     the hidden ones included; the closest matches first, with why each matched.
 *
 * Chat and dispatch sessions never appear: they do not participate in the lifecycle at all.
 */
export function registerListSessionsTools(r: ToolRegistry, deps: ListSessionsDeps): void {
  for (const def of listSessionsToolDefs(deps)) r.register(def);
}

/** P8b Task 6 — THE definition, driven by both the daemon's shared `ToolRegistry` and the `sessions`
 *  capability server (`capabilities/sessions.ts`), never two copies. */
export function listSessionsToolDefs(deps: ListSessionsDeps): ToolDefinition[] {
  const now = deps.now ?? (() => Date.now());

  return [{
    name: LIST_SESSIONS_TOOL,
    modes: ["dispatch"],
    deferred: true,
    description: [
      "List the work sessions on this Mac — code and Cowork sessions only (chat and the dispatch session itself never appear).",
      `With no arguments: what is going on now — every active and background session, plus the sessions you spawned (an inactive one shows as "completed"; only the newest ${LIST_SESSIONS_RECENT_COMPLETED_CHILDREN} of those). Idle and archived sessions are counted, not listed.`,
      "Each row: session id, state, mode, how long a running turn has been going, working directory, title, transcript file.",
      `query: find a session by what you remember, across ALL sessions (idle and archived included) — words from its title or first message, when it ran ("yesterday", "last week", "monday", "2026-09-30"), its directory, or a file it edited ("the session that edited ~/projects/winter/config.toml", or just the path). The ${LIST_SESSIONS_QUERY_MAX_ROWS} closest matches come back first, each with why it matched.`,
      "Message a session (or resume a finished one) with SendMessage to its id; stop its running turn with TaskStop and its id.",
    ].join(" "),
    args: ListSessionsArgs,
    run(args: z.infer<typeof ListSessionsArgs>) {
      const at = now();
      const rows = deps.store.list().filter((s) => participatesInActivity(s.mode));
      const line = (row: SessionRow, activity: Activity | undefined, why?: string[]): string => {
        const parts = [row.sessionId, stateOf(row, activity), row.mode ?? "code"];
        const startedAt = deps.turnStartedAt(row.sessionId);
        if (startedAt !== undefined) parts.push(`running ${elapsedS(startedAt, at)}s`);
        parts.push(`cwd ${row.cwd ?? "(none)"}`);
        if (row.title) parts.push(`"${row.title}"`);
        parts.push(deps.store.transcriptPath(row.sessionId));
        if (why !== undefined && why.length > 0) parts.push(`matched: ${why.join(", ")}`);
        return parts.join(" | ");
      };
      const footer = "Message one with SendMessage (to: its session id; a finished one is resumed for it); stop its running turn with TaskStop (task_id: its session id).";

      if (args.query !== undefined) {
        if (deps.store.editedFilesBackfilled?.() === false) deps.store.backfillEditedFiles?.();
        const activityOf = new Map<string, Activity | undefined>();
        const queryable: QueryableSession[] = rows.map((row) => {
          activityOf.set(row.sessionId, deps.derive(row, row.sessionId, at));
          const firstMessage = deps.store.firstMessage(row.sessionId);
          return {
            sessionId: row.sessionId,
            ...(row.title ? { title: row.title } : {}),
            ...(firstMessage !== undefined ? { firstMessage } : {}),
            ...(row.cwd ? { cwd: row.cwd } : {}),
            createdAt: row.createdAt,
            lastEventTs: deps.store.lastEventTs(row.sessionId),
            editedFiles: deps.store.editedFiles(row.sessionId),
          };
        });
        const ranked = rankSessions(queryable, parseSessionQuery(args.query, at));
        if (ranked.length === 0) return `no sessions matched "${args.query}" — try other words, a date ("yesterday", "last week") or a file path`;
        const byId = new Map(rows.map((r) => [r.sessionId, r]));
        const shown = ranked.slice(0, LIST_SESSIONS_QUERY_MAX_ROWS);
        const lines = shown.map((m) => line(byId.get(m.session.sessionId)!, activityOf.get(m.session.sessionId), m.why));
        const more = ranked.length - shown.length;
        const header = `${shown.length} closest session${shown.length === 1 ? "" : "s"} for "${args.query}", best first${more > 0 ? ` (${more} more matched — refine the query to reach them)` : ""}`;
        return `${header}\n${lines.join("\n")}\n${footer}`;
      }

      // DEFAULT: active + background, plus Dispatch's spawned sessions (the newest few inactive ones as completed).
      const working = (id: string): boolean => deps.working?.(id) ?? deps.turnStartedAt(id) !== undefined;
      const cand = rows.map((row) => ({ row, activity: deps.derive(row, row.sessionId, at), lastEventTs: deps.store.lastEventTs(row.sessionId) }));
      // A Dispatch-spawned session counts as LIVE only while it is open (`active`) or working: until
      // 2026-10-02 every child was stored with the background flag from birth, so the flag alone would
      // list every finished child a home ever had as "background".
      const childLive = (c: (typeof cand)[number]): boolean => c.activity === "active" || working(c.row.sessionId);
      const isChild = (c: (typeof cand)[number]): boolean => c.row.origin === "dispatch-child";
      const live = cand.filter((c) => (isChild(c) ? c.activity !== "archived" && childLive(c) : c.activity === "active" || c.activity === "background"));
      const completedChildren = cand
        .filter((c) => isChild(c) && c.activity !== "archived" && c.activity !== undefined && !childLive(c))
        .map((c) => ({ ...c, activity: "idle" as Activity }))
        .sort((a, b) => b.lastEventTs - a.lastEventTs);
      const recentCompleted = completedChildren.slice(0, LIST_SESSIONS_RECENT_COMPLETED_CHILDREN);
      const shownSet = [...live, ...recentCompleted].sort((a, b) => b.lastEventTs - a.lastEventTs || (a.row.sessionId < b.row.sessionId ? -1 : 1));
      const hidden = cand.length - shownSet.length;
      const hiddenNote = hidden > 0
        ? `\n${hidden} other session${hidden === 1 ? "" : "s"} (idle, archived${completedChildren.length > recentCompleted.length ? ", older completed children" : ""}) not listed — find one with query.`
        : "";
      if (shownSet.length === 0) return `no active, background or recently completed spawned sessions${hiddenNote}\n${footer}`;
      const shown = shownSet.slice(0, LIST_SESSIONS_MAX_ROWS);
      const lines = shown.map((c) => line(c.row, c.activity));
      const header = shownSet.length > shown.length
        ? `${shown.length} sessions (${shownSet.length - shown.length} more active/background — narrow with query)`
        : `${shown.length} session${shown.length === 1 ? "" : "s"}`;
      return `${header}\n${lines.join("\n")}${hiddenNote}\n${footer}`;
    },
  }];
}
