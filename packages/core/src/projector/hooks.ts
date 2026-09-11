import type { ProtocolSdkMessage } from "./types";

/**
 * ── OBSERVED, NEVER PERSISTED (P8b-8 / P8b-21) ──────────────────────────────────────────────────
 *
 * Four families reach the host that have no `SessionEvent` home, and 8b adds no variant for them:
 *
 *  - **Hook lifecycle** — `hook_started` / `hook_progress` / `hook_response` (§4.5), gated on
 *    `Options.includeHookEvents` and always written to Winter's own audit stream regardless. There
 *    is no `hook_*` SessionEvent and inventing one would re-enter the full seven-step protocol
 *    checklist, Swift side included.
 *  - **`rate_limit_event` / `auth_status`** (§4.7). Neither is the failure frame it looks like: an
 *    HTTP 429 arrives as `system/api_retry` with `error_status: 429`, and `auth_status` is a
 *    LOGIN-FLOW PROGRESS channel, not a credential failure. Projecting either as an `agent_error`
 *    would put a card in the transcript for something that has not gone wrong.
 *  - **`system/api_retry`** — one frame per attempt, BEFORE the delay. A retried request that then
 *    succeeds is not an error, and the terminal `result` is where a genuine failure lands.
 *  - **Winter-only extension messages** — `thinking_tokens`, `model_refusal_*`, `reasoning_summary`,
 *    `model_switch`, `continuity_warning` (§4.7).
 *
 * ── THE LOGGING RULE IS A SECURITY RULE, NOT A TIDINESS ONE ─────────────────────────────────────
 *
 * `summarize` returns a TYPE AND A CODE and nothing else. `system/reasoning_summary` carries a
 * foreign model's reasoning text, `model_refusal_*` carries an `api_refusal_explanation` that §4.7
 * marks display-only and never to be parsed, and `continuity_warning.detail` is prose about counts
 * and identity. None of it is cleared for a log line, and none of it may reach one via a
 * well-meaning `JSON.stringify(msg)` in a debug branch. The allowlist below is per-family and lists
 * the exact scalar fields that may be logged.
 */

type Rec = Record<string, unknown>;

/** Per family, the scalar fields safe to log. Anything not listed is never read. */
const LOGGABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  hook_started: ["hook_name", "hook_event"],
  hook_progress: ["hook_name", "hook_event"],
  hook_response: ["hook_name", "hook_event", "outcome", "exit_code"],
  rate_limit_event: [],
  auth_status: ["isAuthenticating"],
  "system/api_retry": ["attempt", "max_retries", "error_status", "error"],
  "system/status": ["status", "compact_result"],
  "system/compact_boundary": [],
  "system/thinking_tokens": ["estimated_tokens"],
  "system/model_refusal_fallback": ["trigger", "direction"],
  "system/model_refusal_no_fallback": ["trigger"],
  "system/reasoning_summary": ["provider"],
  "system/model_switch": ["reason"],
  "system/continuity_warning": ["warning"],
  "system/permission_denied": ["tool_name", "decision_reason_type"],
  "system/local_command_output": [],
  "system/background_tasks_changed": [],
};

/** `type` or `type/subtype` — the key the tables above and the once-per-kind log dedupe use. */
export function kindOf(msg: ProtocolSdkMessage): string {
  const m = msg as Rec;
  const type = typeof m.type === "string" ? m.type : "<untyped>";
  const subtype = typeof m.subtype === "string" ? m.subtype : undefined;
  return subtype === undefined ? type : `${type}/${subtype}`;
}

/**
 * A log payload for a message the projector does not persist: the kind, plus only the allowlisted
 * scalar fields for that kind. An unknown kind logs its kind ALONE — a future frame family is the
 * likeliest place for a payload nobody has cleared, so the default is to say nothing about it.
 */
export function summarize(msg: ProtocolSdkMessage): Record<string, unknown> {
  const kind = kindOf(msg);
  const allowed = LOGGABLE_FIELDS[kind];
  const out: Record<string, unknown> = { kind };
  if (allowed === undefined) return out;
  const m = msg as Rec;
  for (const field of allowed) {
    const v = m[field];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[field] = v;
  }
  return out;
}

/** True when this daemon has a documented, deliberate decision NOT to persist this kind — as
 *  opposed to having never heard of it. Only the second case is worth a louder log. */
export const isKnownUnpersistedKind = (kind: string): boolean => kind in LOGGABLE_FIELDS;

/** Exported for the allowlist's own test. */
export const UNPERSISTED_KINDS: readonly string[] = Object.keys(LOGGABLE_FIELDS);
