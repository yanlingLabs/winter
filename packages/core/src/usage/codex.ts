import { join } from "node:path";
import type { UsageRecordInput } from "./db";
import { findFiles, scanLinesBackward, timeOf, tokenCount, type FoundFile } from "./ingest-files";
import { kindOfMinutes, percentOf, resetMs, shortStr, staleness, type PlanReading, type PlanWindow } from "./plan";
import type { UsagePricer } from "./pricing";
import { runLines } from "./spawn-lines";

// The user's own Codex install (`docs/claude/usage.md`) — READ ONLY, and only what is needed:
//
//  - TOKENS: the CLI's and desktop app's session rollouts, `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` (and
//    `archived_sessions/`). Only three record kinds are parsed — `session_meta` (its `id` and `model_provider`),
//    `turn_context` (its `model`) and `event_msg`/`token_count` (its numbers). Nothing else of a line is kept: no
//    text, no cwd, no instructions.
//  - PLAN: the same records' `rate_limits` — the newest rollout's tail only, read backwards to the last one — and,
//    first, Codex's own app-server (`account/rateLimits/read`), which asks with Codex's own login.
//  - NEVER `<CODEX_HOME>/auth.json` or any credential: nothing here opens a file outside `sessions/` and
//    `archived_sessions/`.

/** OpenAI's usage counts: `input_tokens` INCLUDES `cached_input_tokens`; `output_tokens` INCLUDES `reasoning_output_tokens`. */
interface CodexTotals { input: number; cached: number; output: number; reasoning: number; total: number }

export interface CodexFileState {
  sid?: string;
  provider?: string;
  model?: string;
  total?: CodexTotals;
}

function totalsOf(v: unknown): CodexTotals | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const u = v as Record<string, unknown>;
  const t = {
    input: tokenCount(u.input_tokens), cached: tokenCount(u.cached_input_tokens), output: tokenCount(u.output_tokens),
    reasoning: tokenCount(u.reasoning_output_tokens), total: tokenCount(u.total_tokens),
  };
  if (t.total === 0) t.total = t.input + t.output;
  return t.input + t.output === 0 ? undefined : t;
}

const minus = (a: CodexTotals, b: CodexTotals): CodexTotals => ({
  input: a.input - b.input, cached: a.cached - b.cached, output: a.output - b.output, reasoning: a.reasoning - b.reasoning, total: a.total - b.total,
});
const nonNegative = (t: CodexTotals): boolean => t.input >= 0 && t.cached >= 0 && t.output >= 0 && t.reasoning >= 0;

/**
 * One rollout line → at most one record, updating `state` (PURE apart from `state`). The delta is the cumulative
 * `total_token_usage` against the previous one in the same file; a file's FIRST count uses `last_token_usage` (a
 * resumed session's file can open with the old session's cumulative total); a total that went DOWN uses
 * `last_token_usage` too; an unchanged total (a repeated count) is nothing.
 */
export function codexRecordOf(line: string, state: CodexFileState, fileId: string, pricer: UsagePricer, fallbackAt: number): UsageRecordInput | undefined {
  if (!line.includes("\"session_meta\"") && !line.includes("\"turn_context\"") && !line.includes("\"token_count\"")) return undefined;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const payload = typeof obj.payload === "object" && obj.payload !== null ? (obj.payload as Record<string, unknown>) : undefined;
  if (payload === undefined) return undefined;
  if (obj.type === "session_meta") {
    const sid = shortStr(payload.id, 80);
    if (sid !== undefined) state.sid = sid;
    const provider = shortStr(payload.model_provider, 40);
    if (provider !== undefined) state.provider = provider;
    const model = shortStr(payload.model, 80);
    if (model !== undefined) state.model = model;
    return undefined;
  }
  if (obj.type === "turn_context") {
    const model = shortStr(payload.model, 80);
    if (model !== undefined) state.model = model;
    return undefined;
  }
  if (obj.type !== "event_msg" || payload.type !== "token_count") return undefined;
  const info = typeof payload.info === "object" && payload.info !== null ? (payload.info as Record<string, unknown>) : undefined;
  if (info === undefined) return undefined;
  const total = totalsOf(info.total_token_usage);
  const last = totalsOf(info.last_token_usage);
  let delta: CodexTotals | undefined;
  if (total !== undefined && state.total !== undefined) {
    if (total.total === state.total.total) return undefined;
    const d = minus(total, state.total);
    delta = nonNegative(d) && d.total > 0 ? d : last;
  } else {
    delta = last ?? total;
  }
  if (total !== undefined) state.total = total;
  if (delta === undefined) return undefined;
  const cacheRead = Math.min(delta.cached, delta.input);
  const usage = { input: delta.input - cacheRead, output: delta.output, cacheRead, cacheWrite: 0 };
  const provider = state.provider ?? "openai";
  const model = state.model ?? "unknown";
  const priced = model === "unknown" ? undefined : pricer.price(provider, model, usage);
  const at = timeOf(obj.timestamp) ?? fallbackAt;
  const sid = state.sid ?? fileId;
  return {
    dedupe: `codex:${sid}:${total?.total ?? `${at}:${delta.total}`}`,
    source: "codex", at, sessionId: sid, provider, model,
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: 0, reasoning: delta.reasoning,
    ...(priced === undefined ? { costBasis: "unknown" as const } : { costUsd: priced.costUsd, costBasis: "estimate" as const, cacheSavingsUsd: priced.cacheSavingsUsd }),
  };
}

export function codexStateOf(raw: Record<string, unknown>): CodexFileState {
  const s: CodexFileState = {};
  if (typeof raw.sid === "string") s.sid = raw.sid;
  if (typeof raw.provider === "string") s.provider = raw.provider;
  if (typeof raw.model === "string") s.model = raw.model;
  const t = raw.total as Record<string, unknown> | undefined;
  if (typeof t === "object" && t !== null) {
    s.total = { input: tokenCount(t.input), cached: tokenCount(t.cached), output: tokenCount(t.output), reasoning: tokenCount(t.reasoning), total: tokenCount(t.total) };
  }
  return s;
}

/** Every rollout file under `<codexHome>/sessions` and `<codexHome>/archived_sessions`. */
export async function codexRollouts(codexHome: string): Promise<FoundFile[]> {
  const accept = (name: string): boolean => name.startsWith("rollout-") && name.endsWith(".jsonl");
  return [...await findFiles(join(codexHome, "sessions"), accept, 4), ...await findFiles(join(codexHome, "archived_sessions"), accept, 1)];
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────

function windowOf(id: string, w: unknown, at: number | undefined, now: number, minutesKey: string, resetKeys: string[], percentKey: string): PlanWindow | undefined {
  if (typeof w !== "object" || w === null) return undefined;
  const r = w as Record<string, unknown>;
  const usedPercent = percentOf(r[percentKey]);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = typeof r[minutesKey] === "number" && Number.isFinite(r[minutesKey]) ? (r[minutesKey] as number) : undefined;
  let resetsAt: number | undefined;
  for (const k of resetKeys) {
    if (k === "resets_in_seconds") {
      const s = r[k];
      if (typeof s === "number" && Number.isFinite(s) && at !== undefined) resetsAt = at + Math.round(s * 1000);
    } else {
      resetsAt = resetMs(r[k]);
    }
    if (resetsAt !== undefined) break;
  }
  return {
    id, kind: kindOfMinutes(windowMinutes), ...(windowMinutes === undefined ? {} : { windowMinutes }), usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }), ...staleness(at, windowMinutes, resetsAt, now),
  };
}

function creditsOf(v: unknown): PlanReading["credits"] {
  if (typeof v !== "object" || v === null) return undefined;
  const c = v as Record<string, unknown>;
  const out: NonNullable<PlanReading["credits"]> = {};
  const has = c.has_credits ?? c.hasCredits;
  if (typeof has === "boolean") out.hasCredits = has;
  if (typeof c.unlimited === "boolean") out.unlimited = c.unlimited;
  const bal = c.balance;
  if (typeof bal === "string" && bal.length <= 32) out.balance = bal;
  else if (typeof bal === "number" && Number.isFinite(bal)) out.balance = String(bal);
  return Object.keys(out).length === 0 ? undefined : out;
}

/** PURE: a rollout record's `rate_limits` (snake_case) as a plan reading, or undefined. */
export function planFromRolloutLine(line: string, now: number): PlanReading | undefined {
  if (!line.includes("\"rate_limits\"")) return undefined;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const payload = obj.payload as Record<string, unknown> | undefined;
  const rl = (payload?.rate_limits ?? obj.rate_limits) as Record<string, unknown> | undefined;
  if (typeof rl !== "object" || rl === null) return undefined;
  const at = timeOf(obj.timestamp);
  const windows = [
    windowOf("primary", rl.primary, at, now, "window_minutes", ["resets_at", "resets_in_seconds"], "used_percent"),
    windowOf("secondary", rl.secondary, at, now, "window_minutes", ["resets_at", "resets_in_seconds"], "used_percent"),
  ].filter((w): w is PlanWindow => w !== undefined);
  if (windows.length === 0) return undefined;
  const planType = shortStr(rl.plan_type, 40);
  const credits = creditsOf(rl.credits);
  return {
    provider: "codex", source: "codex-rollout", ...(at === undefined ? {} : { at }), windows,
    ...(planType === undefined ? {} : { planType }), ...(credits === undefined ? {} : { credits }),
  };
}

/** The newest rollouts' tails, newest first, until one carries `rate_limits` (at most `maxFiles` files). */
export async function codexPlanFromRollouts(files: readonly FoundFile[], now: number, maxFiles = 5): Promise<PlanReading | undefined> {
  const newest = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
  for (const f of newest) {
    let found: PlanReading | undefined;
    await scanLinesBackward(f.path, (line) => {
      found = planFromRolloutLine(line, now);
      return found !== undefined;
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

/** PURE: `account/rateLimits/read`'s result (camelCase, Codex app-server protocol v2) as a plan reading. */
export function planFromAppServer(result: unknown, at: number, now: number): PlanReading | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  const byId = r.rateLimitsByLimitId as Record<string, unknown> | null | undefined;
  const snap = ((byId !== null && typeof byId === "object" ? byId.codex : undefined) ?? r.rateLimits) as Record<string, unknown> | undefined;
  if (typeof snap !== "object" || snap === null) return undefined;
  const windows = [
    windowOf("primary", snap.primary, at, now, "windowDurationMins", ["resetsAt"], "usedPercent"),
    windowOf("secondary", snap.secondary, at, now, "windowDurationMins", ["resetsAt"], "usedPercent"),
  ].filter((w): w is PlanWindow => w !== undefined);
  if (windows.length === 0) return undefined;
  const planType = shortStr(snap.planType, 40);
  const credits = creditsOf(snap.credits);
  const limitReached = shortStr(snap.rateLimitReachedType, 60);
  return {
    provider: "codex", source: "codex-app-server", at, windows,
    ...(planType === undefined ? {} : { planType }), ...(credits === undefined ? {} : { credits }),
    ...(limitReached === undefined ? {} : { limitReached }),
  };
}

export const CODEX_APP_SERVER_TIMEOUT_MS = 8_000;

/**
 * Ask the user's `codex app-server` (stdio JSON-RPC, Codex's own protocol — no `jsonrpc` field): `initialize`, the
 * `initialized` notification, `account/rateLimits/read`, then shut down. Codex answers with its OWN login; Winter
 * reads no Codex credential. `undefined` on any failure (timeout — the process group is killed —, an error reply,
 * a malformed reply, no binary).
 */
export async function codexPlanFromAppServer(executable: string, opts: { timeoutMs?: number; cwd?: string; version?: string; now: () => number }):
  Promise<{ reading?: PlanReading; failure?: string }> {
  const outcome = await runLines(executable, {
    args: ["app-server"], timeoutMs: opts.timeoutMs ?? CODEX_APP_SERVER_TIMEOUT_MS, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    onStart: (io) => io.send({ id: 1, method: "initialize", params: { clientInfo: { name: "winter", title: "Winter", version: opts.version ?? "0" }, capabilities: null } }),
    onLine: (line, io) => {
      let msg: Record<string, unknown>;
      // A line that is not JSON (a banner, a warning) is not the answer: only the replies to our ids are judged.
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
      if (msg.id === 1) {
        if (msg.error !== undefined) return { failure: "initialize-refused" };
        io.send({ method: "initialized" });
        io.send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        return undefined;
      }
      if (msg.id === 2) {
        if (msg.error !== undefined) return { failure: "read-refused" };
        const reading = planFromAppServer(msg.result, opts.now(), opts.now());
        return reading === undefined ? { failure: "malformed" } : { reading };
      }
      return undefined; // a notification or a server request: not ours
    },
  });
  if (outcome.kind === "done") return outcome.value as { reading?: PlanReading; failure?: string };
  return { failure: outcome.kind };
}
