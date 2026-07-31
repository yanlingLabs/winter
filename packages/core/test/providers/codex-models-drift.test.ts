import { describe, expect, test } from "bun:test";
import { CODEX, CODEX_MODELS } from "../../src/providers/codex-config";
import { DEFAULT_COMPACT_THRESHOLD_FRAC } from "../../src/agent/engine";
import { KeychainSecretStore } from "../../src/auth/secret-store";
import { CodexAuthStore } from "../../src/providers/codex-oauth";

/**
 * DRIFT GUARD for `CODEX_MODELS` (packages/core/src/providers/codex-config.ts).
 *
 * Why this file exists: every value in `CODEX_MODELS` was HAND-TRANSCRIBED from a live `/models`
 * payload on 2026-07-10 and never re-derived. One of those transcriptions was wrong by 100,000
 * tokens (`contextWindow: 372_000` for a model whose real window is 272,000), and because the
 * auto-compaction trigger is a fraction OF that number, the bug was invisible: it did not throw,
 * it did not warn, it just quietly moved the compaction threshold ABOVE the provider's own hard
 * ceiling, so the compactor could never fire. A wrong constant with no guard is a silent outage.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MECHANISM, AND WHY THIS ONE (the decision this file is required to state explicitly):
 *
 * TWO layers, because neither alone is trustworthy:
 *
 *   1. PINNED + DATED (always runs, everywhere, including CI with no credentials).
 *      The expected catalogue values are duplicated here as literals next to the date they were
 *      last verified against the live backend. Any hand-edit of `CODEX_MODELS` — the exact act
 *      that produced this bug — now fails a test whose message names the live endpoint and
 *      demands the editor re-derive the number and re-stamp `LAST_VERIFIED`. It cannot detect
 *      drift on the PROVIDER's side (nobody edits our file when OpenAI changes a window), which
 *      is why layer 2 exists.
 *
 *   2. LIVE, CREDENTIAL-GATED, OPT-IN (`NORMA_CODEX_LIVE_DRIFT=1` + a Codex OAuth token present).
 *      The real guard: fetches the catalogue and fails on ANY disagreement. It is skipped — never
 *      failed — when either gate is absent, so CI (no creds) and a plain `bun test` stay green
 *      and offline.
 *
 *      Why gated on an ENV FLAG and not on credential presence alone: on a developer Mac the
 *      credentials ARE present, so a creds-only gate would make the ordinary `bun test` reach the
 *      network and read the LIVE DAEMON's Keychain item on every run — flaky, invasive, and
 *      exactly the kind of ambient side effect a unit suite must not have. Running the live guard
 *      is therefore a deliberate act:
 *
 *          NORMA_CODEX_LIVE_DRIFT=1 bun test codex-models-drift
 *
 *      A staleness nudge (a `console.warn`, never a failure) prints when `LAST_VERIFIED` is more
 *      than STALE_AFTER_DAYS old. Deliberately not an assertion: a date-triggered failure is a
 *      time bomb that breaks a green suite on a day nobody changed any code.
 *
 * The live half NEVER prints, logs or persists the token, and NEVER refreshes it — a refresh
 * rotates the running daemon's stored credential, so a test that refreshed could log the user's
 * daemon out. An expired token surfaces as an HTTP 401 and fails the live test with that message,
 * which is the correct outcome: re-run `norma login` and re-run the guard.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS GUARD DELIBERATELY DOES NOT COVER — `reasoningEffort`.
 *
 * The obvious extension is to check `settings.ts`'s `REASONING_EFFORTS` against the catalogue's
 * `supported_reasoning_levels`. It is deliberately absent, because the catalogue is the source
 * that CAUSED the sibling bug rather than one that would have caught it:
 *   - the live payload (verified 2026-07-31) lists `ultra` under gpt-5.6-sol and gpt-5.6-terra,
 *     yet the Responses endpoint rejects `ultra` with an HTTP 400 from a separate, global,
 *     model-agnostic enum layer. A catalogue-driven check would have ENDORSED the `ultra` that
 *     broke every session (see the 2026-07-31 REASONING_EFFORTS fix);
 *   - conversely `none` appears in NO model's `supported_reasoning_levels`, yet it is genuinely
 *     honoured on all three models (measured live: 0 reasoning tokens vs 42 at `max`);
 *   - and `gpt-5.6-luna` omits `ultra` while its siblings list it, so the field is not even
 *     internally consistent.
 * Effort validity lives in the REQUEST VALIDATOR, not the catalogue: the only honest guard for it
 * is a live probe request per effort, which is a different (and much more expensive) test. Known
 * gap, stated here so the next reader does not "helpfully" add the wrong check.
 */

/** Date the pinned values below were last verified against the live `/models` catalogue. */
const LAST_VERIFIED = "2026-07-31";
const STALE_AFTER_DAYS = 120;

/** The live `/models?client_version=1.0.0` payload for the three user-selectable models, as read
 *  on LAST_VERIFIED. `context_window` and `max_context_window` were BOTH 272000 for all three. */
const PINNED = [
  { id: "gpt-5.6-sol", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-terra", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-luna", contextWindow: 272_000, supportsVision: true },
] as const;

/** The provider's hard ceiling. A request whose context exceeds this is rejected outright — so any
 *  compaction threshold at or above it is unreachable by construction. */
const LIVE_CONTEXT_WINDOW = 272_000;

const RE_DERIVE = `re-derive it from the live catalogue (GET ${CODEX.backendUrl}/models?client_version=1.0.0) and re-stamp LAST_VERIFIED`;

describe("CODEX_MODELS drift guard (pinned + dated)", () => {
  test("every entry matches the pinned live-catalogue values", () => {
    expect(CODEX_MODELS.map((m) => ({ id: m.id, contextWindow: m.contextWindow, supportsVision: m.supportsVision })))
      .toEqual(PINNED.map((p) => ({ ...p })));
    // If this failed and the code is right, the PIN is stale: ${RE_DERIVE}
    expect(RE_DERIVE).toContain("/models");
  });

  test("the compaction threshold each entry produces is REACHABLE — the bug that made auto-compaction dead", () => {
    // THE ARITHMETIC, spelled out because the consequence is invisible in a diff:
    //
    //   BEFORE (bug):  372_000 (hardcoded, hand-transcribed) × 0.75 = 279_000  →  ABOVE the real
    //                  272,000 ceiling. `maybeAutoCompact` fires only when the previous turn's
    //                  context EXCEEDS 279,000 tokens — a context the provider can never return,
    //                  because it hard-fails the request at 272,000 first. So on every Codex model
    //                  the compactor NEVER FIRES: a long session does not get compacted, it dies
    //                  on the provider's hard limit. Auto-compaction was, in practice, dead code.
    //
    //   AFTER  (fix):  272_000 (live) × 0.75 = 204_000  →  68,000 tokens of headroom below the
    //                  ceiling, so the trigger is reached with room to run the summarization turn.
    for (const m of CODEX_MODELS) {
      const trigger = m.contextWindow * DEFAULT_COMPACT_THRESHOLD_FRAC;
      expect(trigger).toBe(204_000);
      expect(trigger).toBeLessThan(LIVE_CONTEXT_WINDOW);
    }
  });

  test("LAST_VERIFIED is a real date, and nudges (never fails) when stale", () => {
    expect(LAST_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ageDays = (Date.now() - Date.parse(LAST_VERIFIED)) / 86_400_000;
    expect(Number.isFinite(ageDays)).toBe(true);
    if (ageDays > STALE_AFTER_DAYS) {
      console.warn(
        `[codex drift guard] CODEX_MODELS last verified ${LAST_VERIFIED} (${Math.round(ageDays)}d ago). ` +
        `Run: NORMA_CODEX_LIVE_DRIFT=1 bun test codex-models-drift`,
      );
    }
  });
});

// ── Live half ────────────────────────────────────────────────────────────────────────────────
// Opt-in AND credential-gated (see the mechanism note at the top of this file). `test.skipIf`
// keeps the skip visible in the runner's output rather than silently omitting the case.
const liveRequested = process.env.NORMA_CODEX_LIVE_DRIFT === "1";

describe("CODEX_MODELS drift guard (live catalogue)", () => {
  test.skipIf(!liveRequested)("every CODEX_MODELS entry agrees with the live /models payload", async () => {
    const tokens = await new CodexAuthStore(new KeychainSecretStore()).load();
    if (!tokens) {
      // No credentials → not a failure. This is the "skipped without creds" half of the contract.
      console.warn("[codex drift guard] no Codex OAuth token in the Keychain — live check skipped. Run: norma login");
      return;
    }
    const res = await fetch(`${CODEX.backendUrl}/models?client_version=1.0.0`, {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
        ...CODEX.headers,
      },
    });
    // NEVER refresh on 401 (it would rotate the live daemon's stored token) — fail loudly instead.
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      models: { slug: string; context_window: number; input_modalities?: string[] }[];
    };

    for (const mi of CODEX_MODELS) {
      const live = payload.models.find((m) => m.slug === mi.id);
      expect(live, `${mi.id} is no longer offered by the live catalogue`).toBeDefined();
      expect(live!.context_window, `${mi.id} contextWindow drifted — ${RE_DERIVE}`).toBe(mi.contextWindow);
      expect((live!.input_modalities ?? []).includes("image"), `${mi.id} supportsVision drifted`).toBe(mi.supportsVision);
    }
    // The pinned values above must equal what we just read, or the pin is lying to every offline run.
    for (const p of PINNED) {
      const live = payload.models.find((m) => m.slug === p.id);
      expect(live!.context_window, `PINNED is stale for ${p.id} — ${RE_DERIVE}`).toBe(p.contextWindow);
    }
  });
});
