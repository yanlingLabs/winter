// Plan readings for the Usage tab (`docs/claude/usage.md`): how full the user's own Codex, Claude Code and Antigravity
// plan windows are, from whichever rung of a source ladder answered, with its age and a staleness verdict.

export type PlanWindowKind = "five_hour" | "weekly" | "weekly_scoped" | "other";

export interface PlanWindow {
  id: string;
  kind: PlanWindowKind;
  /** The window's length when the source said it. */
  windowMinutes?: number;
  /** 0…100. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** A per-model window's model (Claude Code's weekly scoped limits), or the model group a window belongs to
   *  (Antigravity's "Gemini", "Claude & GPT"). */
  scope?: string;
  /** The source's own severity word, when it gave one. */
  severity?: string;
  stale: boolean;
  staleReason?: "older_than_window" | "reset_passed";
  /** The window's STABLE key (`planWindowKey`) — what an alarm names; set on every reading the service answers. */
  windowKey?: string;
}

/** A status-only window (Winter's own codex-oauth report: no percentage). */
export interface PlanStatusWindow {
  rateLimitType?: string;
  status: string;
  resetsAt?: number;
  at: number;
}

export type PlanSource =
  | "codex-app-server" | "codex-rollout" | "winter-codex-oauth"
  | "claude-cli" | "claude-cache"
  | "agy-cli"
  | "none" | "disabled"
  /** The app is not on this Mac (no executable found): the surfaces hide its slot. */
  | "not-installed";

export interface PlanReading {
  provider: "codex" | "claude-code" | "antigravity";
  source: PlanSource;
  /** When the numbers were measured (epoch ms) — a fetch's time, or the record's own time. */
  at?: number;
  windows: PlanWindow[];
  statusOnly?: PlanStatusWindow[];
  planType?: string;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
  limitReached?: string;
  /** Why a rung could not answer, in words safe to show (never content from another app's file). */
  note?: string;
}

/** PURE: a window's stable key — its kind and, when it has one, its scope (lower-cased): the same window whichever rung
 *  read it and whatever index the source gave it ("five_hour", "weekly", "weekly_scoped:fable", "weekly:gemini"). A
 *  window of another length adds its minutes ("other@1440"). */
export function planWindowKey(w: Pick<PlanWindow, "kind" | "scope" | "windowMinutes">): string {
  const base = w.kind === "other" && w.windowMinutes !== undefined ? `other@${Math.round(w.windowMinutes)}` : w.kind;
  const scope = w.scope?.trim().toLowerCase();
  return scope === undefined || scope.length === 0 ? base : `${base}:${scope}`;
}

/** PURE: a window kind from its length (300 min = 5 h, 10 080 = a week). */
export function kindOfMinutes(minutes: number | undefined): PlanWindowKind {
  if (minutes === 300) return "five_hour";
  if (minutes === 10_080) return "weekly";
  return "other";
}

/**
 * PURE: the staleness rule. A reading is stale when it was measured longer ago than its own window (it can no longer
 * describe that window), or when its reset time has passed (the window it describes is over).
 */
export function staleness(at: number | undefined, windowMinutes: number | undefined, resetsAt: number | undefined, now: number):
  { stale: boolean; staleReason?: "older_than_window" | "reset_passed" } {
  if (resetsAt !== undefined && resetsAt <= now) return { stale: true, staleReason: "reset_passed" };
  if (at !== undefined && windowMinutes !== undefined && windowMinutes > 0 && now - at > windowMinutes * 60_000) {
    return { stale: true, staleReason: "older_than_window" };
  }
  return { stale: false };
}

export const percentOf = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;

/** PURE: seconds or ms or ISO → epoch ms. */
export function resetMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export const shortStr = (v: unknown, max = 64): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);
