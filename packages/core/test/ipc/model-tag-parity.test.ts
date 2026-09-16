// WS-20 (plan Task L3.6): every RPC schema with a model field rejects a bare id and accepts a real
// provider-qualified tag — pinned directly against the exported zod schemas (not indirected
// through a `METHODS[method].params` table, which does not exist in this codebase; each schema is
// its own exported const in packages/protocol/src/methods.ts). This is the single place that
// tripwires a schema drifting back to a bare `z.string()` for a model field.
import { describe, expect, test } from "bun:test";
import {
  SessionCreateParams,
  SessionSetModelParams,
  ProviderConfigureParams,
  SyncPushParams,
  SettingsSetAdvisorModelParams,
  SyncConfigModel,
  SessionListResult,
  SyncConfigResult,
  DaemonStatusResult,
} from "@yanlinglabs/winter-protocol";

const BARE = "gpt-5.6-sol";
const TAG = "codex-oauth/gpt-5.6-sol";

describe("model-tag-parity: every RPC schema with a model field refuses a bare id, accepts a tag", () => {
  test("SessionCreateParams.model", () => {
    expect(SessionCreateParams.safeParse({ scope: "test", model: BARE }).success).toBe(false);
    expect(SessionCreateParams.safeParse({ scope: "test", model: TAG }).success).toBe(true);
    // Omitted entirely is still valid — model is optional.
    expect(SessionCreateParams.safeParse({ scope: "test" }).success).toBe(true);
  });

  test("SessionSetModelParams.model", () => {
    expect(SessionSetModelParams.safeParse({ sessionId: "s1", model: BARE }).success).toBe(false);
    expect(SessionSetModelParams.safeParse({ sessionId: "s1", model: TAG }).success).toBe(true);
    // Nullable — a clear is always valid, never validated as a tag.
    expect(SessionSetModelParams.safeParse({ sessionId: "s1", model: null }).success).toBe(true);
  });

  test("ProviderConfigureParams (openai-compatible arm).model", () => {
    const base = { type: "openai-compatible" as const, baseUrl: "https://api.example.com/v1", apiKey: "sk-test" };
    expect(ProviderConfigureParams.safeParse({ ...base, model: BARE }).success).toBe(false);
    expect(ProviderConfigureParams.safeParse({ ...base, model: TAG }).success).toBe(true);
    // model is optional on this arm too.
    expect(ProviderConfigureParams.safeParse(base).success).toBe(true);
  });

  test("SyncPushParams.meta.model", () => {
    const base = { sessionId: "s1", baseSeq: 0, data: "", complete: true };
    expect(SyncPushParams.safeParse({ ...base, meta: { model: BARE } }).success).toBe(false);
    expect(SyncPushParams.safeParse({ ...base, meta: { model: TAG } }).success).toBe(true);
    // meta.model omitted entirely, or meta omitted entirely, is still valid.
    expect(SyncPushParams.safeParse({ ...base, meta: {} }).success).toBe(true);
  });

  test("SettingsSetAdvisorModelParams.model", () => {
    expect(SettingsSetAdvisorModelParams.safeParse({ model: BARE }).success).toBe(false);
    expect(SettingsSetAdvisorModelParams.safeParse({ model: TAG }).success).toBe(true);
    // Nullable — a clear is always valid.
    expect(SettingsSetAdvisorModelParams.safeParse({ model: null }).success).toBe(true);
  });

  test("SyncConfigModel.id (a served picker row, not a param — same schema, same rule)", () => {
    const rowFor = (id: string) => ({ id, providerId: "codex-oauth", displayName: "GPT-5.6 Sol", efforts: [] });
    expect(SyncConfigModel.safeParse(rowFor(BARE)).success).toBe(false);
    expect(SyncConfigModel.safeParse(rowFor(TAG)).success).toBe(true);
  });

  // WS-20 (review round 2, nit f): the three SERVED (result, not param) schemas that also carry a
  // model field — same parity obligation as every param above, just on the daemon's OWN outgoing
  // shape rather than an incoming one.
  test("SessionListResult.sessions[].model", () => {
    const row = { sessionId: "s1", scope: "test", createdAt: 0, lastSeq: 0 };
    expect(SessionListResult.safeParse({ sessions: [{ ...row, model: BARE }] }).success).toBe(false);
    expect(SessionListResult.safeParse({ sessions: [{ ...row, model: TAG }] }).success).toBe(true);
    // model is optional — a row with no override, or predating the field, is still valid.
    expect(SessionListResult.safeParse({ sessions: [row] }).success).toBe(true);
  });

  test("SyncConfigResult.defaultModel", () => {
    const base = { provider: "codex-oauth", exaKey: null, dangerousDomains: [], models: [], defaultEffort: "", clientEfforts: [] };
    expect(SyncConfigResult.safeParse({ ...base, defaultModel: BARE }).success).toBe(false);
    expect(SyncConfigResult.safeParse({ ...base, defaultModel: TAG }).success).toBe(true);
    // "" is the ONE non-tag value this field accepts — "the Mac did not say" / no provider configured.
    expect(SyncConfigResult.safeParse({ ...base, defaultModel: "" }).success).toBe(true);
  });

  test("DaemonStatusResult.provider.model", () => {
    const base = { version: "0.0.0", uptimeMs: 0, socketPath: "/tmp/x.sock", sessionsCount: 0, pluginsCount: 0 };
    expect(DaemonStatusResult.safeParse({ ...base, provider: { id: "codex-oauth", model: BARE } }).success).toBe(false);
    expect(DaemonStatusResult.safeParse({ ...base, provider: { id: "codex-oauth", model: TAG } }).success).toBe(true);
    // provider is nullable — no provider configured at all is still a valid status.
    expect(DaemonStatusResult.safeParse({ ...base, provider: null }).success).toBe(true);
  });
});
