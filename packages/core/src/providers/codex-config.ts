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
     * We SELF-IDENTIFY as "winter" rather than sending codex-rs's first-party value
     * "codex_cli_rs". Deliberate go-public decision (ToS mitigation, option A): Winter is an
     * independent client and says so honestly — we do not impersonate OpenAI's own first-party
     * originator to obtain `is_first_party_originator` treatment. Tradeoff accepted: OpenAI's
     * backend can distinguish (and, if it ever chooses, cleanly gate) Winter traffic; the
     * shipped BYO-API-key path is the sanctioned fallback if the ChatGPT-OAuth route is
     * ever restricted. Do NOT revert to a first-party value to chase fingerprint parity.
     */
    originator: "winter",
  } as Record<string, string>,
} as const;

// WS-20: the static Codex model list (`CODEX_MODELS`), its drift-guard date
// (`CODEX_MODELS_VERIFIED`) and `DEFAULT_CODEX_MODEL` are DELETED — the pinned SDK catalog is now
// the one source for which models a provider serves, and `providers/manager.ts` reads
// `settings.provider.model` verbatim (no deprecated-slug rewrite). See `model-tag.ts`,
// `settings.ts`'s `DEFAULT_PROVIDER`/`pinsFor`.
