import type { ModelInfo } from "./types";

/**
 * Codex OAuth parity constants — MUST track codex-rs (spec §4.5).
 * Provenance + reconciliation: docs/superpowers/research/2026-06-12-codex-parity.md
 *
 * Source: github.com/openai/codex @ 216dee1189fd589ea6c0741a5f92f578a3ca4640 (2026-06-12)
 *   - codex-rs/login/src/auth/manager.rs    → CLIENT_ID, backendUrl, tokenUrl
 *   - codex-rs/login/src/server.rs          → authorizeUrl, callbackPort, scope
 *   - codex-rs/login/src/auth/default_client.rs → originator (DEFAULT_ORIGINATOR)
 *   - codex-rs/core/src/client.rs           → OpenAI-Beta header key
 */
export const CODEX = {
  /** Hydra / Auth0 OAuth application id — shared by all Codex CLI clients. */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",

  /** Authorization endpoint: {issuer}/oauth/authorize */
  authorizeUrl: "https://auth.openai.com/oauth/authorize",

  /** Token exchange + refresh endpoint */
  tokenUrl: "https://auth.openai.com/oauth/token",

  /** Local callback server port (primary; fallback 1457 per codex-rs allow-list) */
  callbackPort: 1455,

  /**
   * OAuth scopes — codex-rs scope string from build_authorize_url (server.rs).
   * Drift vs v1: codex-rs added `api.connectors.read api.connectors.invoke`.
   */
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",

  /**
   * Base URL for ChatGPT Codex backend (append /responses for the responses endpoint).
   * Canonical: CHATGPT_CODEX_BASE_URL in model-provider-info/src/lib.rs
   */
  backendUrl: "https://chatgpt.com/backend-api/codex",

  headers: {
    /**
     * OpenAI-Beta header value for HTTP responses requests.
     * v1 value: "responses=experimental".
     * codex-rs HTTP path has no static default (websocket uses "responses_websockets=2026-02-06").
     * TODO-verify: confirm this header is still required/accepted at next codex-rs release.
     */
    "OpenAI-Beta": "responses=experimental",

    /**
     * Originator header — identifies the client to the ChatGPT backend.
     * We SELF-IDENTIFY as "norma" rather than sending codex-rs's first-party value
     * "codex_cli_rs". Deliberate go-public decision (ToS mitigation, option A): Norma is an
     * independent client and says so honestly — we do not impersonate OpenAI's own first-party
     * originator to obtain `is_first_party_originator` treatment. Tradeoff accepted: OpenAI's
     * backend can distinguish (and, if it ever chooses, cleanly gate) Norma traffic; the
     * shipped BYO-API-key path is the sanctioned fallback if the ChatGPT-OAuth route is
     * ever restricted. Do NOT revert to a first-party value to chase fingerprint parity.
     */
    originator: "norma",
  } as Record<string, string>,
} as const;

/**
 * Static Codex model list — re-verified live 2026-07-31 from /models?client_version=1.0.0
 * (first transcribed 2026-07-10).
 *
 * The backend returns only these slugs for ChatGPT-account auth (OAuth).
 * The v1 static list (gpt-5.2-codex, gpt-5.1-codex, etc.) was stale; those models
 * return HTTP 400 "not supported when using Codex with a ChatGPT account."
 *
 * gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna are the ONLY user-selectable models — per an
 * explicit 2026-07-10 user decision, gpt-5.5 and gpt-5.4/gpt-5.4-mini are FULLY DEPRECATED and
 * deliberately dropped from this list, even though the live /models payload may still list them.
 * codex-auto-review is hidden — excluded from this list, not
 * offered as a user-selectable model. A settings.json that still names a deprecated slug is
 * NOT rejected outright: providers/manager.ts's live model resolver auto-falls-back any
 * configured model not in this list to DEFAULT_CODEX_MODEL (warning once per distinct slug),
 * so an old settings file degrades gracefully rather than erroring every turn.
 * Context windows and vision flags from /models payload field values (`context_window`,
 * `input_modalities` containing "image").
 *
 * contextWindow 272_000: EVERY model the catalogue offers reports `context_window: 272000` —
 * including the three below and every deprecated slug. This entry read `372_000` from
 * 2026-07-10 (a hand-transcription that was never re-derived) until 2026-07-31. It was not a
 * cosmetic error: the auto-compaction trigger is 0.75 × this number, so the wrong value put the
 * threshold at 279,000 — ABOVE the provider's own 272,000 hard ceiling, i.e. unreachable. A long
 * session hit the backend's hard limit and failed instead of ever compacting; auto-compaction was
 * dead on every Codex model. Do not edit this number by hand: re-derive it from the live
 * catalogue. test/providers/codex-models-drift.test.ts is the guard (offline pin + dated,
 * opt-in live comparison) — see its header for how to run the live half.
 *
 * codex-rs fetches models dynamically; this list is the best available static set.
 * TODO-verify: add a live /models fetch path to keep this current.
 */
/** Date `CODEX_MODELS` was last checked against the live `/models` catalogue. Lives HERE, next to
 *  the data it dates, and is read by BOTH the drift guard (test/providers/codex-models-drift.test.ts)
 *  and the release pipeline's staleness nudge (scripts/release.ts §11c) — so the date can never
 *  drift from the numbers it certifies. Re-stamp it only after the guard's LIVE half agrees. */
export const CODEX_MODELS_VERIFIED = "2026-07-31";

export const CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-terra", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
];

/** Default/fallback codex-oauth model — used both as the fresh-install default (settings.ts's
 *  v1→v2 migration) and as the deprecated-slug fallback target (providers/manager.ts's live
 *  model resolver). */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
