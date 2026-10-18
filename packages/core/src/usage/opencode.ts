import type { UsageRecordInput } from "./db";
import { tokenCount } from "./ingest-files";
import { shortStr } from "./plan";
import type { UsagePricer } from "./pricing";
import { probeEnv, runLines } from "./spawn-lines";

// The user's own OpenCode (`docs/claude/usage.md`) — tokens and cost only (its plan limits live on its web console, so
// there is no plan slot). OpenCode reports itself: `opencode stats --standalone --days N --models --cost --json`
// (`--standalone` runs a private server for the one command and exits; seen live 2026-10-18, each run under a second).
// Only per-model token counts, OpenCode's own cost and the active dates are kept; the session, prompt and tool counts in
// the same answer are dropped with the parse.
//
// `--days N` (N ≥ 1) covers the last N LOCAL calendar days including today (`--days 0` = `--days 1` = since local
// midnight; `--days 2` = since yesterday's midnight). So today = stats(1), and the local day k days ago (k ≥ 1) =
// stats(k + 1) − stats(k), per model — a negative difference (it cannot happen, but a clock can move) clamps to 0.
// `--all` lists every active date (`activity[]`) for the one-time backfill.

export const opencodeDaysArgs = (days: number): string[] => ["stats", "--standalone", "--days", String(days), "--models", "--cost", "--json"];
export const OPENCODE_ALL_ARGS = ["stats", "--standalone", "--all", "--json"] as const;
export const OPENCODE_STATS_TIMEOUT_MS = 15_000;

export interface OpencodeModelTotals {
  /** `<providerID>/<id>` (qualified: the same model on another provider is another model). */
  model: string;
  provider: string;
  variant: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** OpenCode's own figure, USD (a free model reports 0). */
  cost: number;
}

export interface OpencodeStats {
  /** Keyed `<model>\u0000<variant>`. */
  models: Map<string, OpencodeModelTotals>;
  /** Active local dates (`YYYY-MM-DD`), from `--all`. */
  activity: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const money = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PURE: the answer's per-model totals and active dates; undefined when it is not a stats answer. OpenCode's `input`
 *  excludes cache reads and writes (they are their own counts) — Winter's normalized shape as it stands. */
export function parseOpencodeStats(text: string): OpencodeStats | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    // A banner before the JSON: from the first line that opens an object.
    const start = text.indexOf("\n{");
    if (start < 0) return undefined;
    try { parsed = JSON.parse(text.slice(start + 1)); } catch { return undefined; }
  }
  if (!isObj(parsed) || (!Array.isArray(parsed.models) && !Array.isArray(parsed.activity) && !isObj(parsed.tokens))) return undefined;
  const models = new Map<string, OpencodeModelTotals>();
  for (const raw of Array.isArray(parsed.models) ? parsed.models : []) {
    if (!isObj(raw) || !isObj(raw.model)) continue;
    const id = shortStr(raw.model.id, 120);
    const provider = shortStr(raw.model.providerID, 40);
    if (id === undefined || provider === undefined) continue;
    const variant = shortStr(raw.model.variant, 40) ?? "default";
    const t = isObj(raw.tokens) ? raw.tokens : {};
    const cache = isObj(t.cache) ? t.cache : {};
    const model = `${provider}/${id}`;
    const key = `${model}\u0000${variant}`;
    const prev = models.get(key);
    const row: OpencodeModelTotals = {
      model, provider, variant, input: tokenCount(t.input), output: tokenCount(t.output), reasoning: tokenCount(t.reasoning),
      cacheRead: tokenCount(cache.read), cacheWrite: tokenCount(cache.write), cost: money(raw.cost),
    };
    models.set(key, prev === undefined ? row : {
      ...prev, input: prev.input + row.input, output: prev.output + row.output, reasoning: prev.reasoning + row.reasoning,
      cacheRead: prev.cacheRead + row.cacheRead, cacheWrite: prev.cacheWrite + row.cacheWrite, cost: prev.cost + row.cost,
    });
  }
  const activity: string[] = [];
  for (const a of Array.isArray(parsed.activity) ? parsed.activity : []) {
    if (isObj(a) && typeof a.date === "string" && DATE_RE.test(a.date) && !activity.includes(a.date)) activity.push(a.date);
  }
  return { models, activity };
}

/** PURE: `wide − narrow` per model (a day's totals from two `--days` runs), every count clamped to 0. */
export function opencodeDifference(wide: OpencodeStats, narrow: OpencodeStats): OpencodeStats {
  const models = new Map<string, OpencodeModelTotals>();
  for (const [key, w] of wide.models) {
    const n = narrow.models.get(key);
    const d = (a: number, b: number | undefined): number => Math.max(0, a - (b ?? 0));
    models.set(key, {
      ...w, input: d(w.input, n?.input), output: d(w.output, n?.output), reasoning: d(w.reasoning, n?.reasoning),
      cacheRead: d(w.cacheRead, n?.cacheRead), cacheWrite: d(w.cacheWrite, n?.cacheWrite), cost: d(w.cost, n?.cost),
    });
  }
  return { models, activity: [] };
}

/** PURE: one day's rows — one per model per variant, `dedupe` = `opencode:<model>:<variant>:<YYYY-MM-DD>`, priced by
 *  OpenCode's own figure (`reported`). A model with no tokens that day has no row. */
export function opencodeDayRecords(stats: OpencodeStats, day: string, at: number, pricer: UsagePricer): UsageRecordInput[] {
  const out: UsageRecordInput[] = [];
  for (const m of stats.models.values()) {
    if (m.input + m.output + m.cacheRead + m.cacheWrite === 0) continue;
    out.push({
      dedupe: `opencode:${m.model}:${m.variant}:${day}`, source: "opencode", at, provider: m.provider, model: m.model,
      input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, reasoning: m.reasoning,
      costUsd: m.cost, costBasis: "reported", cacheSavingsUsd: pricer.savingsFor(m.provider, m.model.slice(m.provider.length + 1), m.cacheRead),
    });
  }
  return out;
}

// ── local calendar days (OpenCode's `--days` are the child's local days; the probe passes `TZ` along) ──────────────

const pad = (n: number): string => String(n).padStart(2, "0");
/** The local calendar date of `ms`. */
export const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parts = (day: string): [number, number, number] => day.split("-").map(Number) as [number, number, number];
/** Local midnight starting `day`, and the next one (a DST day is 23 or 25 hours). */
export const localDayStart = (day: string): number => { const [y, m, d] = parts(day); return new Date(y, m - 1, d).getTime(); };
export const localDayEnd = (day: string): number => { const [y, m, d] = parts(day); return new Date(y, m - 1, d + 1).getTime(); };
/** Local noon of `day`: a row's `at`, inside its own local day bucket whatever the DST shift. */
export const localNoon = (day: string): number => { const [y, m, d] = parts(day); return new Date(y, m - 1, d, 12).getTime(); };
/** How many local days `day` lies before `today` (0 = today). */
export const daysBefore = (day: string, today: string): number => Math.round((localNoon(today) - localNoon(day)) / 86_400_000);
/** The local date `k` days before `today`. */
export const dayMinus = (today: string, k: number): string => { const [y, m, d] = parts(today); return localDay(new Date(y, m - 1, d - k, 12).getTime()); };

export type OpencodeFailure = "no-json" | "exited" | "timeout" | "spawn-failed" | "too-large";

/** One `opencode stats` run (stdin from /dev/null, the probes' allowlisted environment plus its XDG dirs and `TZ`). */
export async function runOpencodeStats(executable: string, args: readonly string[], opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }):
  Promise<{ stats?: OpencodeStats; failure?: OpencodeFailure }> {
  const lines: string[] = [];
  const outcome = await runLines(executable, {
    args: [...args], cwd: opts.cwd, stdin: "ignore", timeoutMs: opts.timeoutMs ?? OPENCODE_STATS_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024,
    env: opts.env ?? probeEnv(["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TZ"]),
    onLine: (line) => { lines.push(line); return undefined; },
  });
  if (outcome.kind !== "exited") return { failure: outcome.kind === "done" ? "no-json" : outcome.kind };
  if (outcome.code !== 0) return { failure: "exited" };
  const stats = parseOpencodeStats(lines.join("\n"));
  return stats === undefined ? { failure: "no-json" } : { stats };
}
