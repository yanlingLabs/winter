// Fixtures for the usage tests (`docs/claude/usage.md`): temp directories shaped like `~/.codex/sessions` and
// `~/.claude/projects`, and FAKE `codex` / `claude` / `agy` / `opencode` executables. Nothing here ever touches the
// real ones.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Strings that must never reach the usage DB, a log or an RPC answer. */
export const SECRETS = ["SECRET-PROMPT-7f3a", "SECRET-ANSWER-91bc", "SecretProjectName", "SECRET-INSTRUCTIONS-c0de", "sk-decoy-6e1d", "DECOY_TOKEN_VALUE"];

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `winter-usage-${prefix}-`));
}

/** The service's probe root under a test home (`<home>/usage`, created): each probe makes its own dir in it. */
export function probeRootIn(home: string): string {
  const dir = join(home, "usage");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

export interface CodexTotals { input: number; cached: number; output: number; reasoning: number }

export function codexMeta(at: number, id = "sess-codex-1", model?: string): string {
  return JSON.stringify({ timestamp: iso(at), type: "session_meta", payload: { id, cwd: "/Users/someone/SecretProjectName", instructions: "SECRET-INSTRUCTIONS-c0de", model_provider: "openai", ...(model === undefined ? {} : { model }) } });
}
export function codexTurnContext(at: number, model: string): string {
  return JSON.stringify({ timestamp: iso(at), type: "turn_context", payload: { cwd: "/Users/someone/SecretProjectName", model, approval_policy: "on-request" } });
}
export function codexMessage(at: number): string {
  return JSON.stringify({ timestamp: iso(at), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SECRET-PROMPT-7f3a" }] } });
}
export function codexTokenCount(at: number, total: CodexTotals, last: CodexTotals, rateLimits?: Record<string, unknown>): string {
  const u = (t: CodexTotals) => ({ input_tokens: t.input, cached_input_tokens: t.cached, output_tokens: t.output, reasoning_output_tokens: t.reasoning, total_tokens: t.input + t.output });
  return JSON.stringify({
    timestamp: iso(at), type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: u(total), last_token_usage: u(last), model_context_window: 272000 }, ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }) },
  });
}
export function codexRateLimits(primaryPct: number, secondaryPct: number, resetsAtSec: { primary: number; secondary: number }): Record<string, unknown> {
  return {
    limit_id: "codex",
    primary: { used_percent: primaryPct, window_minutes: 300, resets_at: resetsAtSec.primary },
    secondary: { used_percent: secondaryPct, window_minutes: 10080, resets_at: resetsAtSec.secondary },
    credits: { has_credits: false, unlimited: false, balance: null },
  };
}

/** `<codexHome>/sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl`. */
export function codexRolloutPath(codexHome: string, at: number, id: string): string {
  const d = new Date(at);
  const dir = join(codexHome, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-${iso(at).replace(/[:.]/g, "-")}-${id}.jsonl`);
}

export function claudeAssistant(at: number, opts: { msgId: string; requestId: string; sessionId?: string; model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; uuid?: string }): string {
  return JSON.stringify({
    parentUuid: null, isSidechain: false, userType: "external", cwd: "/Users/someone/SecretProjectName", sessionId: opts.sessionId ?? "cc-session-1",
    version: "2.1.300", type: "assistant", uuid: opts.uuid ?? `u-${opts.msgId}-${Math.random()}`, timestamp: iso(at), requestId: opts.requestId,
    message: {
      id: opts.msgId, type: "message", role: "assistant", model: opts.model ?? "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "SECRET-ANSWER-91bc" }],
      usage: {
        input_tokens: opts.input ?? 10, cache_creation_input_tokens: opts.cacheWrite ?? 0, cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 100, cache_creation: { ephemeral_5m_input_tokens: (opts.cacheWrite ?? 0) - (opts.cacheWrite1h ?? 0), ephemeral_1h_input_tokens: opts.cacheWrite1h ?? 0 },
      },
    },
  });
}
export function claudeUser(at: number): string {
  return JSON.stringify({ type: "user", cwd: "/Users/someone/SecretProjectName", sessionId: "cc-session-1", timestamp: iso(at), message: { role: "user", content: "SECRET-PROMPT-7f3a" } });
}

export function claudeTranscriptPath(claudeHome: string, session = "cc-session-1", project = "-Users-someone-SecretProjectName"): string {
  const dir = join(claudeHome, "projects", project);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${session}.jsonl`);
}

export const lines = (...ls: string[]): string => ls.map((l) => `${l}\n`).join("");

/** A fake executable: a bun script. `body` runs with `log(obj)` (one stdout line) and `mark(name)` (appends to the
 *  marker file, one line per call — to count spawns and record argv/cwd). */
export function fakeExecutable(dir: string, name: string, body: string): { path: string; markerPath: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const markerPath = join(dir, `${name}.marks`);
  writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
const log = (o) => process.stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\\n");
const mark = (s) => fs.appendFileSync(${JSON.stringify(markerPath)}, s + "\\n");
mark(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, env: Object.keys(process.env).sort() }));
${body}
`);
  chmodSync(path, 0o755);
  return { path, markerPath };
}

/** A fake `codex app-server`. Modes: ok, hang, malformed, error. */
export function fakeCodex(dir: string, mode: "ok" | "hang" | "malformed" | "error" | "banner", rate?: { primary: number; secondary: number; resetsAtSec: number }): { path: string; markerPath: string } {
  const result = {
    ordinaryUsageAllowed: true, accountId: "acct-should-not-matter", rateLimitUpsell: null, rateLimitResetCredits: null, rateLimitsByLimitId: null,
    rateLimits: {
      limitId: "codex", limitName: null, normalModelSlug: null, credits: { hasCredits: true, unlimited: false, balance: "12" },
      individualLimit: null, spendControlReached: null, planType: "pro", rateLimitReachedType: null,
      primary: { usedPercent: rate?.primary ?? 12, windowDurationMins: 300, resetsAt: rate?.resetsAtSec ?? Math.floor(Date.now() / 1000) + 3600 },
      secondary: { usedPercent: rate?.secondary ?? 40, windowDurationMins: 10080, resetsAt: (rate?.resetsAtSec ?? Math.floor(Date.now() / 1000)) + 86400 },
    },
  };
  return fakeExecutable(dir, "codex", `
const mode = ${JSON.stringify(mode)};
if (mode === "hang") { setInterval(() => {}, 1000); }
else {
  if (mode === "banner") log("[experimental] app-server: a banner line that is not JSON");
  const rl = require("node:readline").createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    if (m.method === "initialize") log({ id: m.id, result: { userAgent: "fake", codexHome: "/nowhere", platformFamily: "unix", platformOs: "macos" } });
    else if (m.method === "account/rateLimits/read") {
      if (mode === "malformed") log("this is not json");
      else if (mode === "error") log({ id: m.id, error: { code: -32000, message: "not logged in" } });
      else { log({ method: "account/rateLimits/updated", params: {} }); log({ id: m.id, result: ${JSON.stringify(result)} }); }
    }
  });
  rl.on("close", () => process.exit(0));
}
`);
}

/** A fake `claude -p /usage`. Modes as named. */
export type FakeClaudeMode = "ok" | "no-local-command" | "wrong-command" | "cost" | "turns" | "no-report" | "hang" | "malformed"
  | "is-error" | "model-turn-hang" | "tool-use-exit" | "plant-symlink";

export function fakeClaude(dir: string, mode: FakeClaudeMode, outside = "/nonexistent"): { path: string; markerPath: string } {
  const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
  const report = {
    rate_limits: {
      limits: [
        { group: "session", is_active: true, kind: "session", percent: 23, resets_at: resetsAt, scope: null, severity: "normal" },
        { group: "weekly", is_active: true, kind: "weekly_all", percent: 61, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString(), scope: null, severity: "normal" },
        { group: "weekly", is_active: true, kind: "weekly_scoped", percent: 80, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString(), scope: { model: { display_name: "Fable" }, surface: null }, severity: "warning" },
      ],
    },
    session: { note: "SECRET-ANSWER-91bc" },
  };
  const result = {
    type: "result", subtype: mode === "is-error" ? "error_during_execution" : "success", is_error: mode === "is-error", num_turns: mode === "turns" ? 1 : 0, total_cost_usd: mode === "cost" ? 0.01 : 0,
    usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, result: "",
    ...(mode === "no-local-command" ? {} : { local_command: mode === "wrong-command" ? "cost" : "usage" }),
  };
  return fakeExecutable(dir, "claude", `
const mode = ${JSON.stringify(mode)};
if (process.argv[2] === "auth") {
  // \`claude auth status --json\`: the plan's name beside decoy identity fields that must never be kept.
  log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "decoy-person@example.invalid", orgName: "SECRET-ORG-77", subscriptionType: "max" }, null, 2));
}
else if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "malformed") { log("{not json"); log("still not"); }
else if (mode === "plant-symlink") {
  // A hostile probe: leaves a file and a symlink to a directory OUTSIDE its cwd, then answers normally.
  fs.writeFileSync("left-behind.txt", "x");
  fs.symlinkSync(${JSON.stringify(outside)}, "escape");
  log({ type: "assistant", message: { content: [] }, usage_report: ${JSON.stringify({ rate_limits: { limits: [{ group: "session", is_active: true, kind: "session", percent: 5, resets_at: null, scope: null, severity: "normal" }] } })}, local_command_run: "usage" });
  log(${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, local_command: "usage" })});
}
else if (mode === "model-turn-hang") {
  log({ type: "assistant", message: { content: [{ type: "text", text: "SECRET-ANSWER-91bc" }], usage: { input_tokens: 1200, output_tokens: 30 } } });
  setInterval(() => {}, 1000);
}
else if (mode === "tool-use-exit") {
  log({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], usage: { input_tokens: 0, output_tokens: 0 } } });
}
else {
  log({ type: "system", subtype: "init", session_id: "s", tools: [], mcp_servers: [] });
  ${mode === "no-report" || mode === "is-error" ? "" : `log({ type: "assistant", message: { content: [{ type: "text", text: "SECRET-ANSWER-91bc" }] }, usage_report: ${JSON.stringify(report)}, local_command_run: "usage", local_command_source: "builtin" });`}
  log(${JSON.stringify(result)});
}
`);
}

/** agy's `/usage` answer as seen live (sanitized; `shapes/agy-usage.json`). */
export const AGY_USAGE = JSON.parse(readFileSync(join(import.meta.dir, "shapes", "agy-usage.json"), "utf8")) as Record<string, unknown>;

/** A fake `agy -p /usage --output-format json`. Modes as named; the answer is pretty-printed, like agy's. */
export type FakeAgyMode = "ok" | "banner" | "turns" | "tokens" | "other-command" | "conversation" | "answered" | "no-command" | "no-telemetry"
  | "no-json" | "exit-1" | "hang";

export function fakeAgy(dir: string, mode: FakeAgyMode): { path: string; markerPath: string } {
  const base = JSON.parse(JSON.stringify(AGY_USAGE)) as Record<string, any>;
  base.response = "SECRET-ANSWER-91bc";
  if (mode === "turns") base.num_turns = 1;
  if (mode === "tokens") base.usage.input_tokens = 1200;
  if (mode === "other-command") base.command.name = "chat";
  if (mode === "conversation") base.conversation_id = "conv-123";
  // The model answered "/usage" as a prompt: success, text, no command.
  if (mode === "answered") delete base.command;
  if (mode === "no-command") { delete base.command; base.response = ""; }
  // An answer that does not say how many turns or tokens it took: never read as zero.
  if (mode === "no-telemetry") { delete base.num_turns; delete base.usage; delete base.conversation_id; }
  return fakeExecutable(dir, "agy", `
const mode = ${JSON.stringify(mode)};
if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "no-json") { log("Error: not signed in"); process.exit(1); }
else {
  if (mode === "banner") log("Antigravity CLI 1.0 — a banner line that is not JSON");
  log(JSON.stringify(${JSON.stringify(base)}, null, 1));
  if (mode === "exit-1") process.exit(1);
}
`);
}

/** One model's numbers on one local day, as a fake `opencode` keeps them. */
export interface OpencodeDayModel { id: string; providerID: string; variant?: string; input: number; output: number; reasoning?: number; read?: number; write?: number; cost?: number }
/** A fake OpenCode's history: `daily[k]` = the models' numbers k local days ago (0 = today); `activity` = what `--all`
 *  lists; `fail` = answer garbage and exit 1. */
export interface OpencodeHistory {
  daily: Record<number, OpencodeDayModel[]>;
  activity?: string[];
  fail?: boolean;
  /** Live use: every run adds `grow` × (its run number) input tokens to today's first model — today moves between runs. */
  grow?: number;
}

/**
 * A fake `opencode stats --standalone …`, answering BY ARGV from a data file it re-reads every run (`write` changes
 * it): `--days N` = the sum of `daily[0…N−1]` (`--days 0` = `--days 1`, as OpenCode does), `--all` = everything plus
 * the active dates. Decoy session, prompt and tool fields ride along and must never be kept.
 */
export function fakeOpencode(dir: string, history: OpencodeHistory): { path: string; markerPath: string; write(h: OpencodeHistory): void } {
  const dataPath = join(dir, "opencode-history.json");
  const write = (h: OpencodeHistory): void => writeFileSync(dataPath, JSON.stringify(h));
  write(history);
  const fake = fakeExecutable(dir, "opencode", `
const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, "utf8"));
const argv = process.argv.slice(2);
if (data.fail) { log("Error: SECRET-PROMPT-7f3a"); process.exit(1); }
const countPath = ${JSON.stringify(dataPath)} + ".count";
const count = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0) + 1;
fs.writeFileSync(countPath, String(count));
if (data.grow && data.daily[0] && data.daily[0][0]) data.daily[0][0].input += data.grow * count;
const all = argv.includes("--all");
const n = all ? Infinity : Math.max(1, Number(argv[argv.indexOf("--days") + 1]));
const models = new Map();
for (const [k, list] of Object.entries(data.daily)) {
  if (Number(k) >= n) continue;
  for (const m of list) {
    const key = m.providerID + "/" + m.id + "|" + (m.variant ?? "default");
    const t = models.get(key) ?? { model: { id: m.id, providerID: m.providerID, variant: m.variant ?? "default" }, steps: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 };
    t.steps += 1; t.tokens.input += m.input; t.tokens.output += m.output; t.tokens.reasoning += m.reasoning ?? 0;
    t.tokens.cache.read += m.read ?? 0; t.tokens.cache.write += m.write ?? 0; t.cost += m.cost ?? 0;
    models.set(key, t);
  }
}
log(JSON.stringify({
  range: { from: 0, to: Date.now() }, sessions: 3, prompts: 9, steps: 12,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
  tools: { mode: "detail", usage: [{ name: "SECRET-INSTRUCTIONS-c0de", calls: 1 }] },
  activity: (data.activity ?? []).map((date) => ({ date, steps: 1 })),
  models: [...models.values()],
}, null, 1));
`);
  return { ...fake, write };
}

/** A `.claude.json` with the plan cache AND decoy secret-looking keys that must never escape. */
export function claudeJson(path: string, fetchedAtMs: number, util: Record<string, { utilization: number; resets_at: string }>): void {
  writeFileSync(path, JSON.stringify({
    numStartups: 3, userID: "DECOY_TOKEN_VALUE", oauthAccount: { emailAddress: "someone@example.com", accessToken: "sk-decoy-6e1d" },
    mcpServers: { thing: { env: { API_KEY: "sk-decoy-6e1d" } } },
    projects: { "/Users/someone/SecretProjectName": { history: [{ display: "SECRET-PROMPT-7f3a" }] } },
    cachedUsageUtilization: { fetchedAtMs, utilization: util, limits: [] },
  }));
}
