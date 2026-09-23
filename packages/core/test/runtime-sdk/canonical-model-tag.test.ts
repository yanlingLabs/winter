// WS-21 L3.7 (spec §8 step 5): stored model tags are NEVER rewritten; they canonicalize ON READ through
// the catalog's renames at three parse layers — the live settings view, the runtime-state row decoder,
// and the protocol request parse.
//
// The rule has a liveness guard (lane L1b's derivation: "never shadow a tag that still resolves"): a
// catalog that still has `deepseek/deepseek-v4-flash` as a live row (0.0.20) makes the function the
// identity. The linked catalog is the refreshed one (the old row gone, `deepseek-flash` live); the
// 0.0.20 shape is stood in with `setCatalogKeysForTests`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnWriter, LineDecoder, METHODS, ModelTagSchema, PROTOCOL_VERSION, SessionSetModelParams, SyncPushParams, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { RuntimeChildren } from "../../src/runtime-state/children";
import { buildLiveModelResolver } from "../../src/providers/manager";
import { startIpcServer } from "../../src/ipc/server";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { CATALOG_TAG_RENAMES } from "@yanlinglabs/winter-provider-catalog";
import { canonicalModelTag, canonicalModelTagWith, setCatalogKeysForTests } from "../../src/runtime-sdk/model-tag";
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
  test("the catalog's rename table is exactly its two DeepSeek renames", () => {
    expect(CATALOG_TAG_RENAMES).toEqual({
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

  test("against a 0.0.20-shaped catalog it is the identity (deepseek-v4-flash is still a live row there)", () => {
    setCatalogKeysForTests([OLD, "deepseek-anthropic/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "codex-oauth/gpt-5.6-sol"]);
    expect(canonicalModelTag(OLD)).toBe(OLD);
    expect(canonicalModelTag("deepseek-anthropic/deepseek-v4-flash")).toBe("deepseek-anthropic/deepseek-v4-flash");
  });

  test("against the LINKED catalog (refreshed: the old row gone) both dialects resolve to deepseek-flash", () => {
    expect(canonicalModelTag(OLD)).toBe(NEW);
    expect(canonicalModelTag("deepseek-anthropic/deepseek-v4-flash")).toBe("deepseek-anthropic/deepseek-flash");
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

  test("against a 0.0.20-shaped catalog the wire tag passes through unchanged", () => {
    setCatalogKeysForTests([OLD, "deepseek-anthropic/deepseek-v4-flash", "codex-oauth/gpt-5.6-sol"]);
    expect(ModelTagSchema.parse(OLD)).toBe(OLD);
  });

  test("against the LINKED (refreshed) catalog the wire tag canonicalizes with no stand-in", () => {
    expect(ModelTagSchema.parse(OLD)).toBe(NEW);
  });
});


// Review M3: the remaining raw-settings readers and the children rows canonicalize too.
describe("review M3: the remaining read paths", () => {
  test("runtime_children's model_ref / requested / effective models read canonical; the row keeps what was written", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-canon-children-"));
    const rs = openRuntimeStateDb(home);
    new RuntimeChildren(rs).upsert({
      parentWinterSessionId: "s_p", childId: "c1", agentType: "general", providerId: "deepseek", modelRef: OLD,
      providerCatalogVersion: "x", providerAdapterVersion: "y", status: "running", transcriptRef: "t", startedAt: "t", generation: 1,
      requestedModel: OLD, effectiveModel: OLD,
    });
    setCatalogKeysForTests(REFRESHED);
    const child = new RuntimeChildren(rs).get("s_p", "c1")!;
    expect([child.modelRef, child.requestedModel, child.effectiveModel]).toEqual([NEW, NEW, NEW]);
    expect(rs.db.query<{ m: string }, []>("SELECT model_ref AS m FROM runtime_children").get()!.m).toBe(OLD);
    rs.close();
  });

  test("the provider's live model re-read goes through the live settings view", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-canon-manager-"));
    const path = join(home, "settings.json");
    saveSettings(path, Settings.parse({ schemaVersion: 3, provider: { model: OLD } }));
    setCatalogKeysForTests(REFRESHED);
    const resolve = buildLiveModelResolver(loadSettings(path), path, "deepseek");
    expect(resolve().model).toBe("deepseek-flash");
  });

  test("settings.modelRoles and settings.setModelRole answer canonical tags", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-canon-roles-"));
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, pins: { dream: OLD } }));
    setCatalogKeysForTests([...REFRESHED, "codex-oauth/gpt-5.6-sol", "codex-oauth/gpt-5.6-luna", "codex-oauth/gpt-5.6-terra"]);
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home });
    try {
      const c = await rpcClient(socketPath);
      await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "cli" });
      const roles = await c.request(METHODS.settingsModelRoles, {});
      expect(roles.result.roles["pins.dream"].model).toBe(NEW);
      const set = await c.request(METHODS.settingsSetModelRole, { role: "pins.cleaner", model: "codex-oauth/gpt-5.6-luna" });
      expect(set.result?.roles?.["pins.dream"]?.model).toBe(NEW);
      // …and the file still holds the stored tag
      expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).pins.dream).toBe(OLD);
      c.close();
    } finally { server.stop(); store.close(); }
  });
});

async function rpcClient(socketPath: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: any) => void>();
  let next = 1;
  let writer!: ConnWriter;
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) { for (const line of decoder.push(chunk)) { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); } },
      drain() { writer.onDrain(); },
    },
  });
  writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    request(method: string, params?: unknown): Promise<any> {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((resolve) => pending.set(id, resolve));
    },
    close() { socket.end(); },
  };
}
