import { describe, expect, test } from "bun:test";
import { openRuntimeStateDb, RuntimeSessionRecords } from "../../src/runtime-state";
import { migrateModelRefsToTags } from "../../src/runtime-state/migrations/tags";
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
});
