import { describe, expect, test } from "bun:test";
import { CODEX, CODEX_MODELS, CODEX_MODELS_VERIFIED } from "../../src/providers/codex-config";
import { DEFAULT_COMPACT_THRESHOLD_FRAC } from "../../src/agent/engine";
import { KeychainSecretStore } from "../../src/auth/secret-store";
import { keychainService } from "../../src/profile";
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
 *      The expected catalogue values are pinned here next to `CODEX_MODELS_VERIFIED`, the date
 *      they were last checked against the live backend. Any hand-edit of `CODEX_MODELS` — the
 *      exact act that produced this bug — fails with `RE_DERIVE` attached to the assertion, which
 *      names the live endpoint and demands the editor re-derive the number and re-stamp the date.
 *      Review I1: that message MUST hang off the assertions in THIS half. A bare numeric diff
 *      ("Expected 272000, Received 300000") invites the editor to update the pin to match their
 *      edit — which is the `codex-oauth.test.ts` failure mode this whole task exists to condemn,
 *      reproduced inside the guard built to prevent it. This layer cannot detect drift on the
 *      PROVIDER's side (nobody edits our file when OpenAI changes a window) — that is layer 2.
 *
 *   2. LIVE, CREDENTIAL-GATED, OPT-IN (`NORMA_CODEX_LIVE_DRIFT=1` + a Codex OAuth token present).
 *      The real guard: fetches the catalogue and fails on ANY disagreement. Absent the env flag it
 *      is SKIPPED (`test.skipIf`), so CI and a plain `bun test` stay green and offline.
 *
 *      Opting in with NO credentials FAILS — it does not pass and it does not silently return
 *      (review M1). A guard that reports success when it made no call is worse than one that
 *      reports a skip: "pass" reads as "checked, no drift". This bites in a specific, already-seen
 *      way — `SERVICE` resolves at module load to the DIST keychain (`com.norma.core`), so a
 *      developer working the dev profile would otherwise see a green pass for a check that never
 *      ran. Run it for the dev profile with:
 *
 *          NORMA_CODEX_LIVE_DRIFT=1 bun test codex-models-drift                      # dist login
 *          NORMA_PROFILE=dev NORMA_CODEX_LIVE_DRIFT=1 bun test codex-models-drift    # dev login
 *
 *      Why gated on an ENV FLAG and not on credential presence alone: on a developer Mac the
 *      credentials ARE present, so a creds-only gate would make the ordinary `bun test` reach the
 *      network and read the LIVE DAEMON's Keychain item on every run — flaky, invasive, and
 *      exactly the kind of ambient side effect a unit suite must not have. Running the live guard
 *      is therefore a deliberate act.
 *
 * STALENESS lives in the RELEASE PIPELINE, not here (review M2). `scripts/release.ts` §11c warns
 * — never fails — when `CODEX_MODELS_VERIFIED` is older than the staleness budget
 * (`catalogueStaleness` in scripts/release-lib.ts). Two deliberate choices: a `console.warn` inside
 * a 229-file test run is invisible, and nobody runs this file in isolation on a schedule, so the
 * nudge belongs where a human is watching output at the moment the number actually SHIPS; and it
 * warns rather than fails because a date-triggered test failure reddens a green suite on a day
 * nobody touched code, and the reflexive repair for that is to bump the date without checking
 * anything — which destroys the guard's meaning.
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
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE TWO NON-DERIVED ANCHORS ELSEWHERE IN THE SUITE (review M2, named here because a tripwire
 * nobody can see is not one). `LIVE_CONTEXT_WINDOW` below is this file's single hand-held number
 * and everything here derives from it — but two OTHER files carry 272,000 independently:
 *
 *   • test/providers/codex-oauth.test.ts  — `expect(m.contextWindow).toBe(272_000)` over
 *     CODEX_MODELS. The literal that PINNED the original 372,000 transcription error for three
 *     weeks; it is kept literal on purpose, since deriving it from the constant it guards would
 *     make it prove nothing.
 *   • test/agent/engine-compaction.test.ts — `expect(CODEX_SHAPED.contextWindow * FRAC)
 *     .toBeLessThan(272_000)`, the arithmetic proof that the compaction trigger is REACHABLE at
 *     the provider's real ceiling. It reads the window off `CODEX_MODELS[0]` but compares against
 *     a literal, which is what makes it a check rather than a tautology.
 *
 * That independence is the real guard against a coordinated edit: someone "fixing" a failure by
 * bumping `CODEX_MODELS` and this file together still reddens both of those. Do NOT derive either
 * from `LIVE_CONTEXT_WINDOW` — the duplication is the mechanism.
 */

/** The provider's hard ceiling, as read from the live catalogue on `CODEX_MODELS_VERIFIED`:
 *  `context_window` AND `max_context_window` were both 272000 for all three models (and for every
 *  deprecated slug — the catalogue has no larger model at all). A request whose context exceeds
 *  this is rejected outright, so any compaction threshold at or above it is unreachable by
 *  construction.
 *
 *  Review M3: this is the file's SINGLE hand-held number, and the live half checks it against the
 *  wire. Everything else here derives from it — a guard whose thesis is "a pin copied from the same
 *  hand proves nothing" must not itself carry four copies of the same literal. */
const LIVE_CONTEXT_WINDOW = 272_000;

/** The live `/models?client_version=1.0.0` payload for the three user-selectable models, as read on
 *  `CODEX_MODELS_VERIFIED`. Vision = `input_modalities` contains "image". */
const PINNED = [
  { id: "gpt-5.6-sol", contextWindow: LIVE_CONTEXT_WINDOW, supportsVision: true },
  { id: "gpt-5.6-terra", contextWindow: LIVE_CONTEXT_WINDOW, supportsVision: true },
  { id: "gpt-5.6-luna", contextWindow: LIVE_CONTEXT_WINDOW, supportsVision: true },
] as const;

const RE_DERIVE =
  `DO NOT edit the pin to match the code. Re-derive the value from the live catalogue ` +
  `(GET ${CODEX.backendUrl}/models?client_version=1.0.0 — run ` +
  `\`NORMA_CODEX_LIVE_DRIFT=1 bun test codex-models-drift\`, or ` +
  `\`NORMA_PROFILE=dev …\` on the dev profile) and re-stamp CODEX_MODELS_VERIFIED in ` +
  `src/providers/codex-config.ts. A 100,000-token transcription error survived three weeks of ` +
  `green suites exactly because a pin was edited to agree with the constant.`;

describe("CODEX_MODELS drift guard (pinned + dated)", () => {
  test("every entry matches the pinned live-catalogue values", () => {
    // The message rides the assertion that ACTUALLY RUNS (review I1) — a bare numeric diff invites
    // the one repair this guard exists to prevent.
    expect(
      CODEX_MODELS.map((m) => ({ id: m.id, contextWindow: m.contextWindow, supportsVision: m.supportsVision })),
      `CODEX_MODELS disagrees with the pin (last verified ${CODEX_MODELS_VERIFIED}). ${RE_DERIVE}`,
    ).toEqual(PINNED.map((p) => ({ ...p })));
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
    //
    // Asserted as PROPERTIES of the live ceiling, not as a re-typed 204_000 (review M3): the
    // literal would be `LIVE_CONTEXT_WINDOW × DEFAULT_COMPACT_THRESHOLD_FRAC` copied by hand, which
    // is the move this whole file exists to punish.
    for (const m of CODEX_MODELS) {
      const trigger = m.contextWindow * DEFAULT_COMPACT_THRESHOLD_FRAC;
      expect(trigger, `the trigger is unreachable — ${RE_DERIVE}`).toBeLessThan(LIVE_CONTEXT_WINDOW);
      // Headroom must also be enough to RUN the summarization turn, whose own input is roughly the
      // context being summarized; a threshold one token under the ceiling is reachable but useless.
      expect(
        LIVE_CONTEXT_WINDOW - trigger,
        `too little headroom between the trigger and the ${LIVE_CONTEXT_WINDOW} ceiling to run a compaction`,
      ).toBeGreaterThanOrEqual(50_000);
    }
  });
});

// ── Live half ────────────────────────────────────────────────────────────────────────────────
// Opt-in (see the mechanism note at the top of this file). `test.skipIf` keeps the skip VISIBLE in
// the runner's output rather than silently omitting the case — and, per review M1, missing
// credentials once opted in is a FAILURE, never a pass: a guard that reports success for a check it
// never performed is worse than one that reports a skip.
const liveRequested = process.env.NORMA_CODEX_LIVE_DRIFT === "1";

describe("CODEX_MODELS drift guard (live catalogue)", () => {
  test.skipIf(!liveRequested)("every CODEX_MODELS entry agrees with the live /models payload", async () => {
    const tokens = await new CodexAuthStore(new KeychainSecretStore()).load();
    expect(
      tokens,
      `NORMA_CODEX_LIVE_DRIFT=1 was set but no Codex OAuth token is in the "${keychainService()}" keychain, ` +
      `so NOTHING was checked. Run \`norma login\` — or, if you work the dev profile, re-run with ` +
      `NORMA_PROFILE=dev (this reads the dist keychain by default).`,
    ).toBeTruthy();
    // M7 (whole-branch review): `toBeTruthy`, not `.not.toBeNull()` — the latter PASSES on
    // `undefined`, and the `if (!tokens) return` below would then return CLEANLY out of a green
    // test that made no call. That is the "skipped but actually passed" shape this whole file's
    // review-M1 note condemns, reproduced inside the guard built to prevent it.
    if (!tokens) return; // unreachable past the assertion; narrows the type
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
