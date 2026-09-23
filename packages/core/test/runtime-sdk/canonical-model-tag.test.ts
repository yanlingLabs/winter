// WS-21 L3.7 (spec §8 step 5): stored model tags are NEVER rewritten; they canonicalize ON READ through
// the catalog's renames at three parse layers — the live settings view, the runtime-state row decoder,
// and the protocol request parse.
//
// The rule has a liveness guard (lane L1b's derivation: "never shadow a tag that still resolves"): the
// pinned 0.0.20 catalog still has `deepseek/deepseek-v4-flash` as a live row and no `deepseek-flash`,
// so against it the function is the identity. The refreshed catalog is stood in with
// `setCatalogKeysForTests`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHODS, ModelTagSchema, SyncPushParams, SessionSetModelParams } from "@yanlinglabs/winter-protocol";
import {
  CATALOG_TAG_RENAMES_LOCAL, canonicalModelTag, canonicalModelTagWith, setCatalogKeysForTests,
} from "../../src/runtime-sdk/model-tag";
import { liveSettingsView, loadSettings, saveSettings, Settings } from "../../src/settings";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords } from "../../src/runtime-state/records";
import { SessionStore } from "../../src/sessions/store";

const OLD = "deepseek/deepseek-v4-flash";
const NEW = "deepseek/deepseek-flash";
/** The refreshed catalog's shape for these rows: the old id gone, the new one live. */
const REFRESHED = ["deepseek/deepseek-flash", "deepseek-anthropic/deepseek-flash", "deepseek/deepseek-v4-pro", "codex-oauth/gpt-5.6-sol"];

afterEach(() => setCatalogKeysForTests(undefined));

describe("canonicalModelTag — the rule", () => {
  test("the local copy is exactly the catalog's two DeepSeek renames", () => {
    expect(CATALOG_TAG_RENAMES_LOCAL).toEqual({
      "deepseek/deepseek-v4-flash": "deepseek/deepseek-flash",
      "deepseek-anthropic/deepseek-v4-flash": "deepseek-anthropic/deepseek-flash",
    });
  });

  test("renames only when the old tag is gone AND the new one is live", () => {
    const renames = { [OLD]: NEW };
    expect(canonicalModelTagWith(OLD, renames, new Set([NEW]))).toBe(NEW);
    expect(canonicalModelTagWith(OLD, renames, new Set([OLD, NEW]))).toBe(OLD); // never shadow a live tag
    expect(canonicalModelTagWith(OLD, renames, new Set<string>())).toBe(OLD);  // never rename into nothing
    expect(canonicalModelTagWith("codex-oauth/gpt-5.6-sol", renames, new Set([NEW]))).toBe("codex-oauth/gpt-5.6-sol");
  });

  test("against the PINNED catalog it is the identity (deepseek-v4-flash is still a live row there)", () => {
    expect(canonicalModelTag(OLD)).toBe(OLD);
    expect(canonicalModelTag("deepseek-anthropic/deepseek-v4-flash")).toBe("deepseek-anthropic/deepseek-v4-flash");
  });

  test("against the refreshed catalog both DeepSeek dialects resolve to deepseek-flash", () => {
    setCatalogKeysForTests(REFRESHED);
    expect(canonicalModelTag(OLD)).toBe(NEW);
    expect(canonicalModelTag("deepseek-anthropic/deepseek-v4-flash")).toBe("deepseek-anthropic/deepseek-flash");
    expect(canonicalModelTag("deepseek/deepseek-reasoner")).toBe("deepseek/deepseek-reasoner"); // V16: no rename, refused elsewhere
  });
});

describe("layer 1 — the live settings view (never the file)", () => {
  test("provider.model, pins, reviewer.model, titles.model and runtimes.advisorModel canonicalize; the stored file does not change", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-canon-settings-"));
    const path = join(home, "settings.json");
    saveSettings(path, Settings.parse({
      schemaVersion: 3, provider: { model: OLD },
      pins: { dream: OLD, cleaner: "codex-oauth/gpt-5.6-sol" },
      reviewer: { model: OLD }, titles: { model: OLD }, runtimes: { advisorModel: OLD },
    }));
    const before = readFileSync(path, "utf8");
    setCatalogKeysForTests(REFRESHED);
    const view = liveSettingsView(loadSettings(path));
    expect(view.provider.model as string).toBe(NEW);
    expect(view.pins as Record<string, string>).toEqual({ dream: NEW, cleaner: "codex-oauth/gpt-5.6-sol" });
    expect(view.reviewer?.model as string).toBe(NEW);
    expect(view.titles?.model as string).toBe(NEW);
    expect(view.runtimes?.advisorModel).toBe(NEW);
    // A writer loads, patches and saves — and the tags it did not touch stay as stored (downgrade safety).
    saveSettings(path, loadSettings(path));
    expect(JSON.parse(readFileSync(path, "utf8")).provider.model).toBe(OLD);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("nothing to rename: the same object back", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } });
    const view = liveSettingsView(s);
    expect(liveSettingsView(view)).toEqual(view);
  });
});

describe("layer 2 — the runtime-state row decoder and the sessions.model column", () => {
  test("model_ref, selection_json's modelRef and the session's model read canonical; the rows keep what was written", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-canon-rows-"));
    const rs = openRuntimeStateDb(home);
    rs.db.run(`INSERT INTO runtime_sessions (winter_session_id, runtime_kind, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
      transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json)
      VALUES ('s_1', 'winter-agent', 'deepseek', ?, '/b', 'k', 'k', 'k', 'clean', 'conversation', 'c1', 'recorded', 't', 't', 'idle', ?)`,
      [OLD, JSON.stringify({ runtimeKind: "winter-agent", providerId: "deepseek", modelRef: OLD, family: "deepseek", authFamily: "api-key", reason: "r", decidedAt: "t" })]);
    const store = new SessionStore(home);
    const sid = store.createSession("global", { model: OLD as never });
    setCatalogKeysForTests(REFRESHED);
    const rec = new RuntimeSessionRecords(rs).get("s_1")!;
    expect(rec.modelRef).toBe(NEW);
    expect((rec.selection as { modelRef: string }).modelRef).toBe(NEW);
    expect(store.meta(sid).model).toBe(NEW);
    expect(store.list().find((r) => r.sessionId === sid)?.model).toBe(NEW);
    // the stored values are untouched
    expect(rs.db.query<{ m: string }, []>("SELECT model_ref AS m FROM runtime_sessions").get()!.m).toBe(OLD);
    expect(JSON.parse(rs.db.query<{ j: string }, []>("SELECT selection_json AS j FROM runtime_sessions").get()!.j).modelRef).toBe(OLD);
    store.close();
    rs.close();
  });
});

describe("layer 3 — the protocol request parse", () => {
  test("every ModelTagSchema field canonicalizes (the daemon registered the rule on load)", () => {
    setCatalogKeysForTests(REFRESHED);
    expect(ModelTagSchema.parse(OLD)).toBe(NEW);
    expect(SessionSetModelParams.parse({ sessionId: "s", model: OLD }).model).toBe(NEW);
    const push = SyncPushParams.parse({ sessionId: "s", baseSeq: 0, data: "", complete: true, meta: { model: OLD } });
    expect(push.meta?.model).toBe(NEW);
    expect(typeof METHODS.sessionSetModel).toBe("string");
  });

  test("against the pinned catalog the wire tag passes through unchanged", () => {
    expect(ModelTagSchema.parse(OLD)).toBe(OLD);
  });
});

