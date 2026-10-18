import { open } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRecordInput } from "./db";
import { findFiles, timeOf, tokenCount, type FoundFile } from "./ingest-files";
import { percentOf, resetMs, shortStr, staleness, type PlanReading, type PlanWindow, type PlanWindowKind } from "./plan";
import type { UsagePricer } from "./pricing";
import { probeEnv, runLines } from "./spawn-lines";

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

/** A limit's model scope. Claude Code's `/usage` (2.1.293, seen live 2026-10-18) nests it:
 *  `scope: {model: {display_name: "Fable"}, surface: null}`; a bare string or `{model: "…"}` is read too. */
function scopeOf(v: unknown): string | undefined {
  if (typeof v === "string") return shortStr(v, 60);
  if (typeof v !== "object" || v === null) return undefined;
  const model = (v as Record<string, unknown>).model;
  if (typeof model === "string") return shortStr(model, 60);
  if (typeof model === "object" && model !== null) {
    const m = model as Record<string, unknown>;
    return shortStr(m.display_name, 60) ?? shortStr(m.name, 60) ?? shortStr(m.id, 60);
  }
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
/**
 * The invocation verified on a real install (no hooks, no MCP servers, no session file, stdin closed) plus two HARD
 * bounds in case `/usage` ever reaches the model loop: `--max-turns 1` and `--tools ""` (every built-in tool off; with
 * `--strict-mcp-config` and no `--mcp-config` there are no MCP tools either). Both are documented CLI flags
 * (https://code.claude.com/docs/en/cli-reference); a local command runs no turn and uses no tool, so neither applies to it.
 */
export const CLAUDE_USAGE_ARGS = [
  "-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config",
  "--max-turns", "1", "--tools", "",
] as const;

/** Why a `/usage` run was refused. `guard` (and `guard-model-turn`) mean `/usage` reached the model loop: the caller
 *  switches the rung off for this exact binary. Everything else is an ordinary failure, retried after the throttle. */
export type ClaudeCliFailure = "guard" | "guard-model-turn" | "no-local-command" | "error" | "no-report" | "no-result" | "timeout" | "spawn-failed" | "too-large";

/** PURE: does a stream frame show a MODEL turn (an assistant message that used tokens, or any tool use)? */
export function isModelTurnSignal(msg: Record<string, unknown>): boolean {
  if (msg.type !== "assistant") return false;
  const m = msg.message as Record<string, unknown> | undefined;
  if (typeof m !== "object" || m === null) return false;
  const u = m.usage as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && (tokenCount(u.input_tokens) > 0 || tokenCount(u.output_tokens) > 0)) return true;
  return Array.isArray(m.content) && m.content.some((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use");
}

/**
 * Run the user's `claude` for its `/usage` report. Accepted ONLY when the turn's `result` says it was the local
 * `/usage` command (`local_command: "usage"`), cost nothing and ran no model turn. The `guard` failures (the caller
 * latches the binary off) need POSITIVE evidence of the model loop: turns or cost above 0, another `local_command`, or
 * a model-turn signal in the stream (then also when the run ends without a result). A `result` naming no command
 * (an early startup error) and one with `is_error` but the local command (logged out, offline) are ordinary failures.
 */
export async function claudePlanFromCli(executable: string, opts: { cwd: string; timeoutMs?: number; now: () => number; env?: Record<string, string> }):
  Promise<{ reading?: PlanReading; failure?: ClaudeCliFailure }> {
  let report: unknown;
  let sawModelTurn = false;
  const outcome = await runLines(executable, {
    args: [...CLAUDE_USAGE_ARGS], cwd: opts.cwd, stdin: "ignore", timeoutMs: opts.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS,
    env: opts.env ?? probeEnv(["CLAUDE_CONFIG_DIR"]),
    onLine: (line) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
      if (isModelTurnSignal(msg)) sawModelTurn = true;
      if (msg.type === "assistant" && msg.usage_report !== undefined) { report = msg.usage_report; return undefined; }
      if (msg.type !== "result") return undefined;
      const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
      const turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
      // Latch only on POSITIVE evidence of the model loop: a turn, a cost, another local command — or a model-turn
      // signal earlier in the stream. A result naming no command at all (an early startup error) is ordinary.
      const other = typeof msg.local_command === "string" && msg.local_command !== "usage";
      if (other || cost > 0 || turns > 0) return { failure: "guard" };
      if (sawModelTurn) return { failure: "guard-model-turn" };
      if (msg.local_command !== "usage") return { failure: "no-local-command" };
      if (msg.is_error === true) return { failure: "error" };
      if (report === undefined) return { failure: "no-report" };
      const at = opts.now();
      const windows = windowsFromUsageReport(report, at, at);
      if (windows.length === 0) return { failure: "no-report" };
      return { reading: { provider: "claude-code", source: "claude-cli", at, windows } satisfies PlanReading };
    },
  });
  if (outcome.kind === "done") return outcome.value as { reading?: PlanReading; failure?: ClaudeCliFailure };
  if (sawModelTurn) return { failure: "guard-model-turn" };
  return { failure: outcome.kind === "exited" ? "no-result" : outcome.kind };
}

/** Over this, `~/.claude.json` is not read at all. */
export const CLAUDE_JSON_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The fallback: `cachedUsageUtilization` from Claude Code's `~/.claude.json` (undocumented; refreshed only while
 * Claude Code runs). The file holds unrelated config (possibly MCP env secrets): it is parsed in memory and ONLY that
 * one key is read; nothing else of it is kept, logged or sent.
 */
export async function claudePlanFromCacheFile(path: string, now: number, maxBytes = CLAUDE_JSON_MAX_BYTES): Promise<PlanReading | "over-cap" | undefined> {
  // The cap is enforced on the bytes actually READ (at most cap + 1), whatever a stat said a moment before.
  let text: string;
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(maxBytes + 1);
      let read = 0;
      while (read < buf.length) {
        const { bytesRead } = await fh.read(buf, read, buf.length - read, read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
      if (read > maxBytes) return "over-cap";
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      await fh.close().catch(() => undefined);
    }
  } catch { return undefined; }
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
