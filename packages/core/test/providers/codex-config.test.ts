// Phase 8d task 2.4: relocated from `codex-oauth.test.ts` (deleted alongside `providers/codex-oauth.ts` —
// `CodexOAuthProvider`, the class that test file otherwise covered, was superseded by
// `providers/runtime-provider.ts`'s `createCodexOauthRuntimeProvider` in Winter Phase 8c and never
// re-added). These tests are about `codex-config.ts`'s own `CODEX_MODELS`/`DEFAULT_CODEX_MODEL`
// constants, unrelated to which `Provider` implementation reads them, so they survive verbatim.
import { describe, expect, test } from "bun:test";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";

describe("CODEX_MODELS", () => {
  // 2026-07-10 user decision (4e-fix Task 2): gpt-5.5 and gpt-5.4/gpt-5.4-mini are FULLY
  // DEPRECATED — CODEX_MODELS is now EXACTLY the gpt-5.6 family (sol/terra/luna).
  // A configured settings.json model outside this list falls back at runtime to
  // DEFAULT_CODEX_MODEL (providers/manager.ts's live model resolver), not rejected here.
  //
  // 2026-07-31: this test asserted `372_000` — it PINNED the transcription error it was meant to
  // guard, which is why a 100,000-token mistake survived three weeks of green suites and killed
  // auto-compaction on every Codex model (see codex-config.ts's CODEX_MODELS doc comment). The
  // real window is 272,000, verified live. A pin copied from the same hand as the constant proves
  // nothing; the ONLY guard that can catch this class of drift is a comparison against the live
  // catalogue — test/providers/codex-models-drift.test.ts. Change this number only after that
  // guard's live half agrees.
  test("is EXACTLY the gpt-5.6 family — sol/terra/luna, 272K context, nothing else", () => {
    expect(CODEX_MODELS.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    for (const m of CODEX_MODELS) {
      expect(m.family).toBe("gpt-5");
      expect(m.contextWindow).toBe(272_000);
      expect(m.supportsVision).toBe(true);
    }
  });

  test("gpt-5.5 / gpt-5.4 / gpt-5.4-mini are deprecated — no longer in CODEX_MODELS", () => {
    for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]) {
      expect(CODEX_MODELS.find((mi) => mi.id === id)).toBeUndefined();
    }
  });

  test("codex-auto-review is excluded (hidden model)", () => {
    expect(CODEX_MODELS.find((mi) => mi.id === "codex-auto-review")).toBeUndefined();
  });

  test("DEFAULT_CODEX_MODEL is gpt-5.6-sol and is itself a member of CODEX_MODELS", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(CODEX_MODELS.some((m) => m.id === DEFAULT_CODEX_MODEL)).toBe(true);
  });
});
