// Fixtures for the usage tests (`docs/claude/usage.md`): temp directories shaped like `~/.codex/sessions` and
// `~/.claude/projects`, and FAKE `codex` / `claude` executables. Nothing here ever touches the real ones.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Strings that must never reach the usage DB, a log or an RPC answer. */
export const SECRETS = ["SECRET-PROMPT-7f3a", "SECRET-ANSWER-91bc", "SecretProjectName", "SECRET-INSTRUCTIONS-c0de", "sk-decoy-6e1d", "DECOY_TOKEN_VALUE"];

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `winter-usage-${prefix}-`));
}

/** The service's neutral cwd under a test home (`<home>/neutral`, created). */
export function neutralIn(home: string): string {
  const dir = join(home, "neutral");
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
  | "is-error" | "model-turn-hang" | "tool-use-exit";

export function fakeClaude(dir: string, mode: FakeClaudeMode): { path: string; markerPath: string } {
  const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
  const report = {
    rate_limits: {
      limits: [
        { group: "session", is_active: true, kind: "session", percent: 23, resets_at: resetsAt, scope: null, severity: "normal" },
        { group: "weekly", is_active: true, kind: "weekly_all", percent: 61, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString(), scope: null, severity: "normal" },
        { group: "weekly", is_active: true, kind: "weekly_scoped", percent: 80, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString(), scope: { model: "opus" }, severity: "warning" },
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
if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "malformed") { log("{not json"); log("still not"); }
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

/** A `.claude.json` with the plan cache AND decoy secret-looking keys that must never escape. */
export function claudeJson(path: string, fetchedAtMs: number, util: Record<string, { utilization: number; resets_at: string }>): void {
  writeFileSync(path, JSON.stringify({
    numStartups: 3, userID: "DECOY_TOKEN_VALUE", oauthAccount: { emailAddress: "someone@example.com", accessToken: "sk-decoy-6e1d" },
    mcpServers: { thing: { env: { API_KEY: "sk-decoy-6e1d" } } },
    projects: { "/Users/someone/SecretProjectName": { history: [{ display: "SECRET-PROMPT-7f3a" }] } },
    cachedUsageUtilization: { fetchedAtMs, utilization: util, limits: [] },
  }));
}
