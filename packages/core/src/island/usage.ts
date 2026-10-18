import type { SessionEvent } from "@yanlinglabs/winter-protocol";

// The Winter island's Usage tab, daemon half (`docs/claude/island.md`): what the daemon ALREADY sees about usage and
// limits, gathered for `island.usage` — nothing estimated, nothing fetched from a provider.
//
//  - Plan windows: the runtime's `rate_limit_event` frames (the agent SDK's subscription-shaped quota report — a
//    five-hour or seven-day window, its status, utilization and reset), which the projector observes and never
//    persists. The pinned provider runtime's one producer (`quotaEvent`) writes only `status` (`allowed` /
//    `rejected`) and `resetsAt` in unix seconds; `rateLimitType` and `utilization` (typed after the upstream SDK, a
//    fraction 0…1) are passed through only if a runtime ever sends them. The latest report per window kind is kept, in memory, since the daemon started.
//  - Per session: the tokens its `turn_completed` events counted since the daemon started (often 0 for a provider row
//    that reports no usage), and the last measured context size (`contextTokens`, sent only for a single-round turn).
//  - The rest (Winter's background jobs' quota and subscription snapshot, a model's context window) is read from its
//    owner at ask time through `IslandUsageSources`.

/** A plan-window report, as the projector hands it over (the SDK's `SDKRateLimitInfo`). */
export interface RateLimitInfo {
  status?: unknown;
  rateLimitType?: unknown;
  resetsAt?: unknown;
  utilization?: unknown;
}

export interface IslandUsageWindow {
  rateLimitType?: string;
  status: string;
  utilization?: number;
  /** Epoch ms. */
  resetsAt?: number;
  at: number;
  sessionId: string;
  /** The provider the reporting session's model names (`codex-oauth`, …), when known. */
  provider?: string;
}

export interface IslandSessionUsage {
  sessionId: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  contextWindow?: number;
  model?: string;
}

export interface IslandUsageSources {
  /** `quota.state`'s numbers: Winter's background jobs (titles, reviewer, dreamer, cleaner, research). */
  background(): { kind: "ok" | "limited"; resumeAt?: number; inputTokens: number; outputTokens: number };
  /** The background jobs' latest subscription-quota snapshot (`QuotaManager.subscriptionQuota()`). */
  subscription?(): { info: Record<string, unknown>; at: number } | undefined;
  /** The session's model tag and its context window, when the catalog knows them. */
  modelOf?(sessionId: string): { model?: string; contextWindow?: number } | undefined;
}

export interface IslandUsageSnapshot {
  windows: IslandUsageWindow[];
  subscription?: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number; at: number };
  background: { kind: "ok" | "limited"; resumeAt?: number; inputTokens: number; outputTokens: number };
  session?: IslandSessionUsage;
}

/** Sessions whose counters are held at most (least recently updated dropped first). */
export const ISLAND_USAGE_MAX_SESSIONS = 256;
/** Window kinds held at most (the SDK names six). */
const MAX_WINDOWS = 16;

/** PURE: the runtime's `resetsAt` — unix SECONDS (the provider runtime's `quotaEvent` writes
 *  `Math.round(resumeAt / 1000)`) — as epoch ms. */
export function epochMs(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(v * 1000);
}

function str(v: unknown, max = 64): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export class IslandUsageRegistry {
  private readonly windows = new Map<string, IslandUsageWindow>();
  private readonly sessions = new Map<string, { turns: number; inputTokens: number; outputTokens: number; contextTokens?: number }>();

  constructor(private readonly sources: IslandUsageSources, private readonly now: () => number = Date.now) {}

  /** A `rate_limit_event`'s info, from a session's projector. Only the four named scalars are read. */
  noteRateLimit(sessionId: string, info: RateLimitInfo, provider?: string): void {
    const status = str(info.status);
    if (status === undefined) return;
    const rateLimitType = str(info.rateLimitType);
    const key = `${provider ?? ""}\u0000${rateLimitType ?? "unspecified"}`;
    const utilization = num(info.utilization);
    const resetsAt = epochMs(info.resetsAt);
    this.windows.delete(key);
    this.windows.set(key, {
      ...(rateLimitType === undefined ? {} : { rateLimitType }), status,
      ...(utilization === undefined ? {} : { utilization }), ...(resetsAt === undefined ? {} : { resetsAt }),
      at: this.now(), sessionId, ...(provider === undefined ? {} : { provider: provider.slice(0, 64) }),
    });
    while (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value as string);
  }

  /** The windows a provider's sessions reported (the usage tab's Codex fallback: `codex-oauth`), newest first. */
  windowsFor(provider: string): IslandUsageWindow[] {
    return [...this.windows.values()].filter((w) => w.provider === provider).sort((a, b) => b.at - a.at);
  }

  /** Every appended event (`SessionHub.addObserver`): a turn's token counts. */
  observe(event: SessionEvent): void {
    if (event.type !== "turn_completed") return;
    const prev = this.sessions.get(event.sessionId) ?? { turns: 0, inputTokens: 0, outputTokens: 0 };
    const next = {
      turns: prev.turns + 1,
      inputTokens: prev.inputTokens + (num(event.inputTokens) ?? 0),
      outputTokens: prev.outputTokens + (num(event.outputTokens) ?? 0),
      ...(num(event.contextTokens) !== undefined ? { contextTokens: event.contextTokens } : prev.contextTokens !== undefined ? { contextTokens: prev.contextTokens } : {}),
    };
    this.sessions.delete(event.sessionId);
    this.sessions.set(event.sessionId, next);
    while (this.sessions.size > ISLAND_USAGE_MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
  }

  snapshot(sessionId?: string): IslandUsageSnapshot {
    let background: IslandUsageSnapshot["background"];
    try { background = this.sources.background(); } catch { background = { kind: "ok", inputTokens: 0, outputTokens: 0 }; }
    let subscription: IslandUsageSnapshot["subscription"];
    try {
      const s = this.sources.subscription?.();
      if (s !== undefined) {
        const status = str(s.info.status);
        const rateLimitType = str(s.info.rateLimitType);
        const utilization = num(s.info.utilization);
        const resetsAt = epochMs(s.info.resetsAt);
        subscription = {
          ...(status === undefined ? {} : { status }), ...(rateLimitType === undefined ? {} : { rateLimitType }),
          ...(utilization === undefined ? {} : { utilization }), ...(resetsAt === undefined ? {} : { resetsAt }), at: s.at,
        };
      }
    } catch { subscription = undefined; }
    let session: IslandSessionUsage | undefined;
    if (sessionId !== undefined) {
      const counted = this.sessions.get(sessionId) ?? { turns: 0, inputTokens: 0, outputTokens: 0 };
      let model: { model?: string; contextWindow?: number } | undefined;
      try { model = this.sources.modelOf?.(sessionId); } catch { model = undefined; }
      session = {
        sessionId, ...counted,
        ...(model?.model === undefined ? {} : { model: model.model }),
        ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      };
    }
    return {
      windows: [...this.windows.values()],
      ...(subscription === undefined ? {} : { subscription }),
      background,
      ...(session === undefined ? {} : { session }),
    };
  }
}
