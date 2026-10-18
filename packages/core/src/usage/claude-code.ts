import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRecordInput } from "./db";
import { findFiles, timeOf, tokenCount, type FoundFile } from "./ingest-files";
import { percentOf, resetMs, shortStr, staleness, type PlanReading, type PlanWindow, type PlanWindowKind } from "./plan";
import type { UsagePricer } from "./pricing";
import { runLines } from "./spawn-lines";

// The user's own Claude Code (`docs/claude/usage.md`) — READ ONLY, and only what is needed:
//
//  - TOKENS: its local transcripts, `<claude config dir>/projects/**/*.jsonl`. Only `assistant` records with a
//    `message.usage` are parsed, and only `message.usage`'s four counts (+ the one-hour cache-write subset),
//    `message.model`, `message.id`, `requestId`, `sessionId` and `timestamp` are kept. Never a message's content,
//    never the cwd, never the project directory's name (the read state is keyed by a hash of the path).
//  - PLAN: Claude Code's own `/usage` report (`claude -p "/usage" …`, which asks with Claude Code's own login), else
//    the `cachedUsageUtilization` key of `~/.claude.json` (parsed in memory; nothing else of that file is kept).
//  - NEVER Claude Code's Keychain item or token: Winter does not read, copy or use Claude Code's credentials
//    (https://code.claude.com/docs/en/legal-and-compliance) — the CLI makes its own call, Winter reads its output.

/** One transcript line → at most one record (PURE). Streamed messages repeat across lines: `dedupe` is the message id
 *  plus the request id, so the first copy wins. */
export function claudeCodeRecordOf(line: string, pricer: UsagePricer, fallbackAt: number): UsageRecordInput | undefined {
  if (!line.includes("\"assistant\"") || !line.includes("\"usage\"")) return undefined;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  if (obj.type !== "assistant") return undefined;
  const message = obj.message as Record<string, unknown> | undefined;
  if (typeof message !== "object" || message === null) return undefined;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const model = shortStr(message.model, 80);
  if (model === undefined || model === "<synthetic>") return undefined;
  const messageId = shortStr(message.id, 80);
  const requestId = shortStr(obj.requestId, 80);
  const uuid = shortStr(obj.uuid, 80);
  if (messageId === undefined && uuid === undefined) return undefined;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const cacheWrite1h = typeof creation === "object" && creation !== null ? Math.min(tokenCount(creation.ephemeral_1h_input_tokens), cacheWrite) : 0;
  const priced = pricer.price("anthropic", model, { input, output, cacheRead, cacheWrite, ...(cacheWrite1h > 0 ? { cacheWrite1h } : {}) });
  const sessionId = shortStr(obj.sessionId, 80);
  return {
    dedupe: messageId !== undefined ? `cc:${messageId}:${requestId ?? ""}` : `cc:u:${uuid}`,
    source: "claude-code", at: timeOf(obj.timestamp) ?? fallbackAt, ...(sessionId === undefined ? {} : { sessionId }),
    provider: "anthropic", model, input, output, cacheRead, cacheWrite,
    ...(priced === undefined ? { costBasis: "unknown" as const } : { costUsd: priced.costUsd, costBasis: "estimate" as const, cacheSavingsUsd: priced.cacheSavingsUsd }),
  };
}

export async function claudeCodeTranscripts(claudeHome: string): Promise<FoundFile[]> {
  return findFiles(join(claudeHome, "projects"), (name) => name.endsWith(".jsonl"), 5);
}

// ── the plan (the seam: `ClaudeCodePlanUsageSource`) ─────────────────────────────────────────────

export interface ClaudeCodePlanUsageSource {
  read(): Promise<PlanReading>;
}

/** A source that has nothing (tracking switched off, or nothing installed). */
export const unavailableClaudeCodePlan = (source: "none" | "disabled", note?: string): ClaudeCodePlanUsageSource => ({
  async read() { return { provider: "claude-code", source, windows: [], ...(note === undefined ? {} : { note }) }; },
});

function claudeKind(kind: string | undefined, group: string | undefined): { kind: PlanWindowKind; minutes?: number } {
  if (kind === "session" || group === "session" || kind === "five_hour") return { kind: "five_hour", minutes: 300 };
  if (kind === "weekly_all" || kind === "seven_day") return { kind: "weekly", minutes: 10_080 };
  if (kind === "weekly_scoped" || (kind ?? "").startsWith("seven_day_")) return { kind: "weekly_scoped", minutes: 10_080 };
  if (group === "weekly") return { kind: "weekly", minutes: 10_080 };
  return { kind: "other" };
}

function scopeOf(v: unknown): string | undefined {
  if (typeof v === "string") return shortStr(v, 60);
  if (typeof v === "object" && v !== null) return shortStr((v as Record<string, unknown>).model, 60);
  return undefined;
}

/** PURE: a stream-json `usage_report`'s limits as plan windows. */
export function windowsFromUsageReport(report: unknown, at: number, now: number): PlanWindow[] {
  if (typeof report !== "object" || report === null) return [];
  const rl = (report as Record<string, unknown>).rate_limits;
  const limits = Array.isArray(rl) ? rl : typeof rl === "object" && rl !== null ? (rl as Record<string, unknown>).limits : undefined;
  if (!Array.isArray(limits)) return [];
  const out: PlanWindow[] = [];
  for (const [i, raw] of limits.entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as Record<string, unknown>;
    const usedPercent = percentOf(l.percent);
    if (usedPercent === undefined) continue;
    const k = claudeKind(shortStr(l.kind), shortStr(l.group));
    const resetsAt = resetMs(l.resets_at);
    const scope = scopeOf(l.scope);
    const severity = shortStr(l.severity, 24);
    out.push({
      id: `${shortStr(l.kind) ?? "limit"}${scope === undefined ? "" : `:${scope}`}:${i}`, kind: k.kind,
      ...(k.minutes === undefined ? {} : { windowMinutes: k.minutes }), usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }), ...(scope === undefined ? {} : { scope }), ...(severity === undefined ? {} : { severity }),
      ...staleness(at, k.minutes, resetsAt, now),
    });
  }
  return out;
}

export const CLAUDE_USAGE_TIMEOUT_MS = 15_000;
/** EXACTLY the invocation verified on a real install: no hooks, no MCP servers, no session file, stdin closed. */
export const CLAUDE_USAGE_ARGS = ["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"] as const;

/**
 * Run the user's `claude` for its `/usage` report. Accepted ONLY when the turn's `result` says it was the local
 * `/usage` command (`local_command: "usage"`), cost nothing and ran no model turn (`num_turns: 0`) — anything else
 * means `/usage` reached the model loop, which is a `guard` failure (the caller stops using this rung).
 */
export async function claudePlanFromCli(executable: string, opts: { cwd: string; timeoutMs?: number; now: () => number }):
  Promise<{ reading?: PlanReading; failure?: string }> {
  let report: unknown;
  const outcome = await runLines(executable, {
    args: [...CLAUDE_USAGE_ARGS], cwd: opts.cwd, stdin: "ignore", timeoutMs: opts.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS,
    onLine: (line) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
      if (msg.type === "assistant" && msg.usage_report !== undefined) { report = msg.usage_report; return undefined; }
      if (msg.type !== "result") return undefined;
      const cost = msg.total_cost_usd;
      const guardOk = msg.local_command === "usage" && (cost === undefined || cost === 0) && (msg.num_turns === undefined || msg.num_turns === 0)
        && msg.is_error !== true;
      if (!guardOk) return { failure: "guard" };
      if (report === undefined) return { failure: "no-report" };
      const at = opts.now();
      const windows = windowsFromUsageReport(report, at, at);
      if (windows.length === 0) return { failure: "no-report" };
      return { reading: { provider: "claude-code", source: "claude-cli", at, windows } satisfies PlanReading };
    },
  });
  if (outcome.kind === "done") return outcome.value as { reading?: PlanReading; failure?: string };
  return { failure: outcome.kind === "exited" ? "no-result" : outcome.kind };
}

/**
 * The fallback: `cachedUsageUtilization` from Claude Code's `~/.claude.json` (undocumented; refreshed only while
 * Claude Code runs). The file holds unrelated config (possibly MCP env secrets): it is parsed in memory and ONLY that
 * one key is read; nothing else of it is kept, logged or sent.
 */
export async function claudePlanFromCacheFile(path: string, now: number): Promise<PlanReading | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return undefined; }
  let cached: unknown;
  try { cached = (JSON.parse(text) as Record<string, unknown>).cachedUsageUtilization; } catch { return undefined; }
  text = "";
  if (typeof cached !== "object" || cached === null) return undefined;
  const c = cached as Record<string, unknown>;
  const at = typeof c.fetchedAtMs === "number" && Number.isFinite(c.fetchedAtMs) ? c.fetchedAtMs : undefined;
  const util = c.utilization as Record<string, unknown> | undefined;
  if (typeof util !== "object" || util === null) return undefined;
  const windows: PlanWindow[] = [];
  for (const [key, raw] of Object.entries(util)) {
    if (typeof raw !== "object" || raw === null) continue;
    const w = raw as Record<string, unknown>;
    const usedPercent = percentOf(w.utilization);
    if (usedPercent === undefined) continue;
    const k = claudeKind(key, undefined);
    const resetsAt = resetMs(w.resets_at);
    const scope = key.startsWith("seven_day_") ? shortStr(key.slice("seven_day_".length), 40) : undefined;
    windows.push({
      id: shortStr(key, 40) ?? "window", kind: k.kind, ...(k.minutes === undefined ? {} : { windowMinutes: k.minutes }), usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }), ...(scope === undefined ? {} : { scope }), ...staleness(at, k.minutes, resetsAt, now),
    });
  }
  if (windows.length === 0) return undefined;
  return { provider: "claude-code", source: "claude-cache", ...(at === undefined ? {} : { at }), windows };
}
