import { tokenCount } from "./ingest-files";
import { resetMs, shortStr, staleness, type PlanReading, type PlanWindow, type PlanWindowKind } from "./plan";
import { probeEnv, runLines } from "./spawn-lines";

// The user's own Antigravity CLI (`agy`, Google's successor to the Gemini CLI; `docs/claude/usage.md`) — its plan
// windows only, from its OWN `/usage` report: `agy -p "/usage" --output-format json --print-timeout 20s`. A print-mode
// read-only slash command answers with a structured payload "without starting an agent turn, spending quota, or
// leaving a conversation behind" (agy's changelog); seen live 2026-10-18: exit 0, `num_turns` 0, every `usage` count 0,
// `conversation_id` "". Winter NEVER reads agy's sign-in or tokens — the CLI makes its own call, Winter reads its output.
//
// Shape: `command.name` "usage", `command.data.groups[] {name, description, buckets[] {id, name, window ("weekly" |
// "5h"), remaining_fraction (0…1), reset_time (ISO UTC)}}`. Groups seen: "Gemini Models" (gemini-weekly, gemini-5h)
// and "Claude and GPT models" (3p-weekly, 3p-5h). Only those numbers, ids, windows, times and the group's name are
// kept; the descriptions and the text `response` are dropped with the parse.

export const AGY_USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"] as const;
/** Above agy's own `--print-timeout 20s`, so it is never killed just before it answers. */
export const AGY_USAGE_TIMEOUT_MS = 25_000;

/** Why a `/usage` run was refused. `guard` means it reached the model loop (a turn, tokens, another command, a
 *  conversation left behind): the caller latches the binary off. Everything else is ordinary, retried after the throttle. */
export type AgyCliFailure = "guard" | "no-command" | "error" | "no-report" | "no-json" | "timeout" | "spawn-failed" | "too-large";

/** PURE: a group's name, shortly — "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude & GPT"; an unknown
 *  group keeps its name (without a trailing "models"). */
export function agyGroupScope(name: unknown): string | undefined {
  const raw = shortStr(name, 60);
  if (raw === undefined) return undefined;
  const base = raw.replace(/\s+models$/i, "").trim();
  if (base.length === 0) return raw;
  return /^claude and gpt$/i.test(base) ? "Claude & GPT" : base;
}

function agyKind(window: string | undefined): { kind: PlanWindowKind; minutes?: number } {
  if (window === "5h") return { kind: "five_hour", minutes: 300 };
  if (window === "weekly") return { kind: "weekly", minutes: 10_080 };
  return { kind: "other" };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** PURE: `command.data`'s buckets as plan windows (used = 1 − remaining). */
export function windowsFromAgyUsage(data: unknown, at: number, now: number): PlanWindow[] {
  if (!isObj(data) || !Array.isArray(data.groups)) return [];
  const out: PlanWindow[] = [];
  for (const group of data.groups) {
    if (!isObj(group) || !Array.isArray(group.buckets)) continue;
    const scope = agyGroupScope(group.name);
    for (const [i, raw] of group.buckets.entries()) {
      if (!isObj(raw)) continue;
      const remaining = raw.remaining_fraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
      const usedPercent = Math.max(0, Math.min(100, Math.round((1 - remaining) * 100)));
      const k = agyKind(shortStr(raw.window, 16));
      const resetsAt = resetMs(raw.reset_time);
      out.push({
        id: shortStr(raw.id, 40) ?? `${scope ?? "group"}:${i}`, kind: k.kind, ...(k.minutes === undefined ? {} : { windowMinutes: k.minutes }),
        usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }), ...(scope === undefined ? {} : { scope }),
        ...staleness(at, k.minutes, resetsAt, now),
      });
    }
  }
  return out;
}

/**
 * PURE: judge agy's whole answer. Accepted ONLY when it was the `usage` command, ran no turn and counted no token. The
 * `guard` failure (the caller latches the binary) needs POSITIVE evidence of the model loop: turns or a token count
 * above 0, another command, or a conversation left behind. No command at all, an error status, no groups: ordinary.
 */
export function judgeAgyUsage(parsed: unknown, at: number): { reading?: PlanReading; failure?: AgyCliFailure } {
  if (!isObj(parsed)) return { failure: "no-json" };
  const turns = typeof parsed.num_turns === "number" ? parsed.num_turns : 0;
  const usage = isObj(parsed.usage) ? parsed.usage : {};
  const tokens = Object.values(usage).some((v) => tokenCount(v) > 0);
  const command = isObj(parsed.command) ? parsed.command : undefined;
  const name = command === undefined ? undefined : command.name;
  const other = typeof name === "string" && name !== "usage";
  const conversation = typeof parsed.conversation_id === "string" && parsed.conversation_id.length > 0;
  if (turns > 0 || tokens || other || conversation) return { failure: "guard" };
  if (name !== "usage") return { failure: "no-command" };
  if (typeof parsed.status === "string" && parsed.status !== "SUCCESS") return { failure: "error" };
  const windows = windowsFromAgyUsage(command!.data, at, at);
  if (windows.length === 0) return { failure: "no-report" };
  return { reading: { provider: "antigravity", source: "agy-cli", at, windows } };
}

/** PURE: the JSON document in agy's stdout — the whole of it, else from the first line that opens an object (a banner
 *  before it is ignored). */
export function agyJsonOf(lines: readonly string[]): unknown {
  const whole = lines.join("\n");
  try { return JSON.parse(whole); } catch { /* a banner first, perhaps */ }
  const start = lines.findIndex((l) => l.startsWith("{"));
  if (start < 0) return undefined;
  try { return JSON.parse(lines.slice(start).join("\n")); } catch { return undefined; }
}

/** Run the user's `agy` for its `/usage` report (stdin from /dev/null, the probes' allowlisted environment). */
export async function antigravityPlanFromCli(executable: string, opts: { cwd: string; timeoutMs?: number; now: () => number; env?: Record<string, string> }):
  Promise<{ reading?: PlanReading; failure?: AgyCliFailure }> {
  const lines: string[] = [];
  const outcome = await runLines(executable, {
    args: [...AGY_USAGE_ARGS], cwd: opts.cwd, stdin: "ignore", timeoutMs: opts.timeoutMs ?? AGY_USAGE_TIMEOUT_MS, maxBytes: 1024 * 1024,
    env: opts.env ?? probeEnv(),
    onLine: (line) => { lines.push(line); return undefined; },
  });
  const parsed = agyJsonOf(lines);
  lines.length = 0;
  // Positive evidence of a model turn latches whatever the exit; anything else needs a clean exit to be read.
  if (parsed !== undefined) {
    const judged = judgeAgyUsage(parsed, opts.now());
    if (judged.failure === "guard") return judged;
    if (outcome.kind === "exited" && outcome.code === 0) return judged;
  }
  if (outcome.kind === "timeout" || outcome.kind === "spawn-failed" || outcome.kind === "too-large") return { failure: outcome.kind };
  return { failure: parsed === undefined ? "no-json" : "error" };
}
