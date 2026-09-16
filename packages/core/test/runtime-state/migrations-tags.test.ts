import { describe, expect, test } from "bun:test";
import { openRuntimeStateDb, RuntimeSessionRecords } from "../../src/runtime-state";
import { migrateModelRefsToTags } from "../../src/runtime-state/migrations/tags";
import { credentialRefFor } from "../../src/runtime-sdk/keychain";
import { withTempHome, ISO } from "./support";

function seedSession(records: RuntimeSessionRecords, home: string, id: string, providerId: string, modelRef: string) {
  records.create({
    winterSessionId: id,
    runtimeKind: "winter-agent",
    providerId,
    modelRef,
    backendRoot: `${home}/projects/x`,
    transcriptProjectKey: "x",
    memoryProjectKey: "x",
    tempProjectKey: "x",
    transcriptDialect: "claude-code-jsonl",
    transcriptHealth: "unsupported",
    compatibilityLevel: "conversation",
    conformanceCorpusVersion: "legacy",
    versionProvenance: "legacy-unknown",
    capabilities: ["import-conversation"],
    selection: {
      runtimeKind: "winter-agent", providerId, modelRef, family: "legacy",
      authFamily: "custom", sdkVersion: "unknown", reason: "backfill", decidedAt: ISO(),
    } as any,
  });
}

describe("WS-20 (spec §5): migrateModelRefsToTags", () => {
  test("a codex-oauth row's bare model_ref becomes codex-oauth/<id>", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        seedSession(records, home, "s_a", "codex-oauth", "gpt-5.6-terra");
        const report = migrateModelRefsToTags({ rs, home });
        expect(report.sessionsRewritten).toBe(1);
        expect(records.get("s_a")!.modelRef).toBe("codex-oauth/gpt-5.6-terra");
      } finally {
        rs.close();
      }
    });
  });

  test("a legacy openai-compatible row's provider_id maps to openai/<id>", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        seedSession(records, home, "s_b", "openai-compatible", "gpt-5.6-sol");
        migrateModelRefsToTags({ rs, home });
        expect(records.get("s_b")!.modelRef).toBe("openai/gpt-5.6-sol");
      } finally {
        rs.close();
      }
    });
  });

  test("a row whose model_ref is the unknown/unstated sentinel becomes unstated/unstated, never <provider>/unknown", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        seedSession(records, home, "s_c", "codex-oauth", "unknown");
        seedSession(records, home, "s_d", "codex-oauth", "unstated");
        migrateModelRefsToTags({ rs, home });
        expect(records.get("s_c")!.modelRef).toBe("unstated/unstated");
        expect(records.get("s_d")!.modelRef).toBe("unstated/unstated");
      } finally {
        rs.close();
      }
    });
  });

  test("a row already holding a tag is left untouched (idempotent)", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        seedSession(records, home, "s_e", "codex-oauth", "codex-oauth/gpt-5.6-luna");
        const report = migrateModelRefsToTags({ rs, home });
        expect(report.sessionsRewritten).toBe(0);
        expect(records.get("s_e")!.modelRef).toBe("codex-oauth/gpt-5.6-luna");
      } finally {
        rs.close();
      }
    });
  });

  // WS-20 (review round 2, nit d): `auth_ref` is rewritten alongside `model_ref`, from the
  // RESULTING tag's own provider — so a migrated row's stored ref agrees with the model it now
  // names (spec §10's claim).
  test("nit(d): auth_ref is rewritten from the resulting tag's own provider", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        seedSession(records, home, "s_f", "codex-oauth", "gpt-5.6-terra");
        migrateModelRefsToTags({ rs, home });
        const expected = credentialRefFor("codex-oauth", home);
        expect(records.get("s_f")!.authRef).toBe(expected?.kind === "keychain" ? `keychain:${expected.account}` : undefined);
      } finally {
        rs.close();
      }
    });
  });

  // WS-20 (review round 2, M5): a row whose `provider_id` is NOT a catalog provider this daemon
  // recognises falls back to `migrateBareModelId`'s rule 5 — now presence-aware, same as the
  // settings migration.
  test("M5: a row with an unrecognized provider_id and an ambiguous model_ref prefers a credentialed provider", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        // "legacy-provider" is not a pinned catalog provider — falls to the S-based fallback rule.
        // "gpt-5.6-terra" is served by codex-oauth/openai/kie (genuinely ambiguous).
        seedSession(records, home, "s_g", "legacy-provider", "gpt-5.6-terra");
        const report = migrateModelRefsToTags({ rs, home, presentProviders: new Set(["openai"]) });
        expect(report.sessionsRewritten).toBe(1);
        expect(records.get("s_g")!.modelRef).toBe("openai/gpt-5.6-terra");
      } finally {
        rs.close();
      }
    });
  });
});
