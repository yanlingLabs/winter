import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, loadPermissionDirs, addLocalDir, saveSettings, Settings, REASONING_EFFORTS, setProviderModel, setReasoningEffort, hooksEnabledFrom, setOutputStyle } from "../src/settings";
import { DEFAULT_CODEX_MODEL } from "../src/providers/codex-config";
import { mkdirSync, writeFileSync as wf } from "node:fs";

function tmpSettings(content: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), "norma-set-")), "settings.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe("loadSettings", () => {
  test("migrates schemaVersion 1 → 2 with codex-oauth default and persists", () => {
    const p = tmpSettings({ schemaVersion: 1 });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.provider).toEqual({ type: "codex-oauth", model: DEFAULT_CODEX_MODEL }); // gpt-5.4 fully deprecated — default points at the current model
    expect(JSON.parse(readFileSync(p, "utf8")).schemaVersion).toBe(2); // migration persisted
  });

  test("valid v2 settings load as-is", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://api.openai.com/v1" } });
    expect(loadSettings(p).provider.type).toBe("openai-compatible");
  });

  // SP-approvals T10 (spec §7): permissions.dangerousDomains.added — the user-added half of
  // web_fetch's dangerous-domain floor (agent/dangerous-domains.ts's SHIPPED_DANGEROUS_DOMAINS is
  // the other, immutable half). Additive optional key — absent means "no user additions".
  test("permissions.dangerousDomains.added round-trips through the schema", () => {
    const p = tmpSettings({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: DEFAULT_CODEX_MODEL },
      permissions: { dangerousDomains: { added: ["evil-example.net", "exfil.example.org"] } },
    });
    const s = loadSettings(p);
    expect(s.permissions?.dangerousDomains?.added).toEqual(["evil-example.net", "exfil.example.org"]);
  });

  test("permissions.dangerousDomains absent is valid (no user additions)", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "codex-oauth", model: DEFAULT_CODEX_MODEL } });
    expect(loadSettings(p).permissions?.dangerousDomains).toBeUndefined();
  });

  test("permissions.dangerousDomains.added rejects a non-array value", () => {
    const p = tmpSettings({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: DEFAULT_CODEX_MODEL },
      permissions: { dangerousDomains: { added: "not-an-array" } },
    });
    expect(() => loadSettings(p)).toThrow(/settings/);
  });

  test("corrupt settings throw a readable error", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "telepathy" } });
    expect(() => loadSettings(p)).toThrow(/settings/);
  });

  test("missing settings file throws a readable error", () => {
    expect(() => loadSettings(join(mkdtempSync(join(tmpdir(), "norma-set-")), "settings.json"))).toThrow(/norma daemon run/);
  });

  test("legacy v1-app settings (no schemaVersion) migrate, preserving v1 keys", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.provider.type).toBe("codex-oauth");
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.legacyCustom).toEqual({ provider: "disabled" }); // v1 data preserved on disk
    expect(onDisk.schemaVersion).toBe(2);
  });

  test("v1→v2 migration preserves unknown fields on disk", () => {
    const p = tmpSettings({ schemaVersion: 1, custom: true });
    loadSettings(p);
    expect(JSON.parse(readFileSync(p, "utf8")).custom).toBe(true);
  });

  test("v1→v2 migration preserves a permissions block in the parsed result", () => {
    const p = tmpSettings({ schemaVersion: 1, permissions: { additionalDirectories: ["~/kept", "/opt/kept"] } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.permissions?.additionalDirectories).toEqual(["~/kept", "/opt/kept"]);
    // and on disk:
    const onDisk = JSON.parse(require("node:fs").readFileSync(p, "utf8"));
    expect(onDisk.permissions.additionalDirectories).toEqual(["~/kept", "/opt/kept"]);
  });

  test("legacy no-schemaVersion file with permissions migrates and keeps them", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" }, permissions: { additionalDirectories: ["/opt/x"] } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.permissions?.additionalDirectories).toEqual(["/opt/x"]);
  });

  test("mcpServers parses; absent → undefined; legacy migration keeps working", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], env: { X: "1" } } } });
    if (!s.mcpServers) throw new Error("mcpServers must be defined");
    expect(s.mcpServers["everything"]?.command).toBe("npx");
    const none = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } });
    expect(none.mcpServers).toBeUndefined();
  });

  test("reviewer config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, reviewer: { enabled: true, model: "gpt-5.4-mini", allow: ["git status"] } });
    expect(s.reviewer).toEqual({ enabled: true, model: "gpt-5.4-mini", allow: ["git status"] });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).reviewer).toBeUndefined();
  });

  test("legacy migration keeps working with reviewer field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.reviewer).toBeUndefined();
  });

  // Phase 5e T4: reviewer.classes — additive per-class on/off, subordinate to reviewer.enabled.
  const base54 = { schemaVersion: 2 as const, provider: { type: "codex-oauth" as const, model: "gpt-5.4" } };

  test("reviewer.classes parses all three booleans; absent block/field → undefined", () => {
    const s = Settings.parse({ ...base54, reviewer: { classes: { bash: false, fs: true, external: false } } });
    expect(s.reviewer?.classes).toEqual({ bash: false, fs: true, external: false });
    expect(Settings.parse({ ...base54, reviewer: {} }).reviewer?.classes).toBeUndefined();
    expect(Settings.parse(base54).reviewer).toBeUndefined();
  });

  test("reviewer.classes: a partial object (one key set) round-trips exactly — the other two keys stay absent, not defaulted-in at the settings layer", () => {
    const s = Settings.parse({ ...base54, reviewer: { classes: { fs: false } } });
    expect(s.reviewer?.classes).toEqual({ fs: false });
    expect(s.reviewer?.classes).not.toHaveProperty("bash");
    expect(s.reviewer?.classes).not.toHaveProperty("external");
  });

  test("reviewer.classes coexists with enabled:false — the settings layer stores both independently; precedence (enabled:false wins regardless of classes) is the engine's job, not the parser's", () => {
    const s = Settings.parse({ ...base54, reviewer: { enabled: false, classes: { bash: true, fs: true, external: true } } });
    expect(s.reviewer).toEqual({ enabled: false, classes: { bash: true, fs: true, external: true } });
  });

  test("reviewer.classes: an unrecognized key inside the block is tolerated — stripped like every other zod object here, never rejects the whole settings file", () => {
    const s = Settings.parse({ ...base54, reviewer: { classes: { bash: false, network: true } } });
    expect(s.reviewer?.classes).toEqual({ bash: false });
    expect(s.reviewer?.classes).not.toHaveProperty("network");
  });

  test("reviewer.classes: a non-boolean class value is rejected (same throw-on-bad-shape idiom as worktree.baseRef / toolSearch.deferExternals / subagents.maxDepth)", () => {
    expect(() => Settings.parse({ ...base54, reviewer: { classes: { bash: "nope" } } })).toThrow();
    expect(() => Settings.parse({ ...base54, reviewer: { classes: "everything" } })).toThrow();
  });

  test("legacy migration keeps working with reviewer.classes absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.reviewer?.classes).toBeUndefined();
  });

  test("plugins config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, plugins: { enabled: ["a"], disabled: ["b"] } });
    expect(s.plugins).toEqual({ enabled: ["a"], disabled: ["b"] });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).plugins).toBeUndefined();
  });

  test("legacy migration keeps working with plugins field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.plugins).toBeUndefined();
  });

  test("toolSearch config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, toolSearch: { enabled: true, deferThreshold: 20 } });
    expect(s.toolSearch).toEqual({ enabled: true, deferThreshold: 20 });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).toolSearch).toBeUndefined();
  });

  test("toolSearch.deferExternals parses 'count'/'always'; absent → undefined; bad value rejected", () => {
    const count = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, toolSearch: { deferExternals: "count" } });
    expect(count.toolSearch).toEqual({ deferExternals: "count" });
    const always = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, toolSearch: { enabled: true, deferThreshold: 20, deferExternals: "always" } });
    expect(always.toolSearch).toEqual({ enabled: true, deferThreshold: 20, deferExternals: "always" });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, toolSearch: {} }).toolSearch?.deferExternals).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, toolSearch: { deferExternals: "sometimes" } })).toThrow();
  });

  test("legacy migration keeps working with toolSearch field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.toolSearch).toBeUndefined();
  });

  test("worktree config parses; absent → undefined; bad baseRef rejected", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, worktree: { baseRef: "fresh" } });
    expect(s.worktree).toEqual({ baseRef: "fresh" });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).worktree).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, worktree: { baseRef: "bogus" } })).toThrow();
  });

  test("legacy migration keeps working with worktree field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.worktree).toBeUndefined();
  });

  test("subagents config parses; absent → undefined; non-positive maxConcurrent rejected", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxConcurrent: 2 } });
    expect(s.subagents).toEqual({ maxConcurrent: 2 });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).subagents).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxConcurrent: 0 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxConcurrent: -1 } })).toThrow();
  });

  // 4h-i Task 3: subagents.maxDepth — CC parity (CC allows nesting depth up to 5; Norma's engine
  // defaults to 2 when this is unset — see engine.ts's `subagentMaxDepth ?? 2`).
  test("subagents.maxDepth parses (1-5 inclusive); absent → undefined; out-of-range/non-integer rejected", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxDepth: 3 } });
    expect(s.subagents).toEqual({ maxDepth: 3 });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).subagents).toBeUndefined();

    // boundaries: 1 and 5 both accepted
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxDepth: 1 } }).subagents).toEqual({ maxDepth: 1 });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxDepth: 5 } }).subagents).toEqual({ maxDepth: 5 });

    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxDepth: 0 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxDepth: 6 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxDepth: 2.5 } })).toThrow();

    // maxConcurrent and maxDepth coexist independently within the same subagents block
    const both = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, subagents: { maxConcurrent: 2, maxDepth: 4 } });
    expect(both.subagents).toEqual({ maxConcurrent: 2, maxDepth: 4 });
  });

  // No-timeout task (user rule 2026-07-12): subagents.timeoutMs is the EXPLICIT wall-clock
  // opt-in (ABSENT = no wall clock at all — the new default); subagents.stallTimeoutMs overrides
  // the progress-stall watchdog window (ABSENT = the manager's 600000 default). Both hot via
  // daemon.ts's live getters.
  test("subagents.timeoutMs + stallTimeoutMs parse (positive ints); absent → undefined (no wall clock / stall default); zero/negative/non-integer rejected", () => {
    const base = { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } };

    const s = Settings.parse({ ...base, subagents: { timeoutMs: 300000, stallTimeoutMs: 900000 } });
    expect(s.subagents).toEqual({ timeoutMs: 300000, stallTimeoutMs: 900000 });

    // absent fields stay absent — daemon.ts's getters resolve them to undefined, which is what
    // SubagentManager reads as "no wall clock" / "use the 600s stall default"
    const bare = Settings.parse({ ...base, subagents: { maxConcurrent: 2 } });
    expect(bare.subagents?.timeoutMs).toBeUndefined();
    expect(bare.subagents?.stallTimeoutMs).toBeUndefined();

    // each rejects zero / negative / non-integer (same positive-int idiom as maxConcurrent)
    expect(() => Settings.parse({ ...base, subagents: { timeoutMs: 0 } })).toThrow();
    expect(() => Settings.parse({ ...base, subagents: { timeoutMs: -5 } })).toThrow();
    expect(() => Settings.parse({ ...base, subagents: { timeoutMs: 1.5 } })).toThrow();
    expect(() => Settings.parse({ ...base, subagents: { stallTimeoutMs: 0 } })).toThrow();
    expect(() => Settings.parse({ ...base, subagents: { stallTimeoutMs: -5 } })).toThrow();
    expect(() => Settings.parse({ ...base, subagents: { stallTimeoutMs: 1.5 } })).toThrow();

    // all four subagents knobs coexist
    const all = Settings.parse({ ...base, subagents: { maxConcurrent: 3, maxDepth: 2, timeoutMs: 120000, stallTimeoutMs: 300000 } });
    expect(all.subagents).toEqual({ maxConcurrent: 3, maxDepth: 2, timeoutMs: 120000, stallTimeoutMs: 300000 });
  });

  test("legacy migration keeps working with subagents field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.subagents).toBeUndefined();
  });

  // 4g Task 6: webSearch.provider defaults (unset) to Brave; "brave" is the only accepted literal
  // today (forward-room for other backends later).
  test("webSearch config parses; absent → undefined; non-brave provider rejected", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, webSearch: { provider: "brave" } });
    expect(s.webSearch).toEqual({ provider: "brave" });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).webSearch).toBeUndefined();
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, webSearch: {} }).webSearch).toEqual({});
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, webSearch: { provider: "disabled" } })).toThrow();
  });

  test("legacy migration keeps working with webSearch field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.webSearch).toBeUndefined();
  });

  test("provider.reasoningEffort parses on both provider variants; absent → undefined", () => {
    const codex = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol", reasoningEffort: "high" } });
    expect(codex.provider.reasoningEffort).toBe("high");
    const openai = Settings.parse({ schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://x", reasoningEffort: "xhigh" } });
    expect(openai.provider.reasoningEffort).toBe("xhigh");
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } }).provider.reasoningEffort).toBeUndefined();
  });

  test("every documented reasoning-effort slug parses; an invalid slug is rejected", () => {
    expect(REASONING_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    for (const effort of REASONING_EFFORTS) {
      const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol", reasoningEffort: effort } });
      expect(s.provider.reasoningEffort).toBe(effort);
    }
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol", reasoningEffort: "bogus" } })).toThrow();
  });

  test("hooks config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, hooks: { enabled: false } });
    expect(s.hooks).toEqual({ enabled: false });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).hooks).toBeUndefined();
  });

  test("legacy migration keeps working with hooks field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.hooks).toBeUndefined();
  });

  // Phase 5f Task 4: lsp.enabled/idleShutdownMs — mirrors hooks/toolSearch/subagents' own
  // optional-nested-block shape (unknown keys stripped, wrong-typed known keys throw).
  test("lsp config parses (both fields); absent block → undefined", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { enabled: false, idleShutdownMs: 60_000 } });
    expect(s.lsp).toEqual({ enabled: false, idleShutdownMs: 60_000 });
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }).lsp).toBeUndefined();
  });

  test("lsp: a partial object (one field set) round-trips exactly — the other field stays absent, not defaulted-in at the settings layer", () => {
    const enabledOnly = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { enabled: true } });
    expect(enabledOnly.lsp).toEqual({ enabled: true });
    expect(enabledOnly.lsp).not.toHaveProperty("idleShutdownMs");
    const idleOnly = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { idleShutdownMs: 1000 } });
    expect(idleOnly.lsp).toEqual({ idleShutdownMs: 1000 });
    expect(idleOnly.lsp).not.toHaveProperty("enabled");
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: {} }).lsp).toEqual({});
  });

  test("lsp: an unrecognized key inside the block is tolerated — stripped like every other zod object here, never rejects the whole settings file", () => {
    const s = Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { enabled: true, maxWorkers: 4 } });
    expect(s.lsp).toEqual({ enabled: true });
    expect(s.lsp).not.toHaveProperty("maxWorkers");
  });

  test("lsp: a wrong-typed known key throws (same idiom as subagents.maxConcurrent / worktree.baseRef)", () => {
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { enabled: "yes" } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { idleShutdownMs: -1 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { idleShutdownMs: 0 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, lsp: { idleShutdownMs: "60000" } })).toThrow();
  });

  test("legacy migration keeps working with lsp field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(2);
    expect(s.lsp).toBeUndefined();
  });

  // Sparkle T5: updates.channel — beta/stable auto-update channel, read live by the app at
  // each check (no daemon restart needed — see UpdaterCoordinator.readChannelFromSettings()).
  test("updates.channel accepts stable/beta/absent and rejects junk", () => {
    const base = { schemaVersion: 2 as const, provider: { type: "codex-oauth" as const, model: "gpt-5.4" } };
    expect(Settings.safeParse({ ...base, updates: { channel: "beta" } }).success).toBe(true);
    expect(Settings.safeParse({ ...base, updates: { channel: "stable" } }).success).toBe(true);
    expect(Settings.safeParse({ ...base, updates: {} }).success).toBe(true);
    expect(Settings.safeParse({ ...base, updates: { channel: "nightly" } }).success).toBe(false);
  });
});

describe("hooksEnabledFrom (4f: hooks.enabled default-ON semantics)", () => {
  const base = { schemaVersion: 2 as const, provider: { type: "codex-oauth" as const, model: "gpt-5.4" } };

  test("hooks block absent → enabled", () => {
    expect(hooksEnabledFrom(Settings.parse(base))).toBe(true);
  });

  test("hooks.enabled absent (block present, field absent) → enabled", () => {
    expect(hooksEnabledFrom(Settings.parse({ ...base, hooks: {} }))).toBe(true);
  });

  test("hooks.enabled: true → enabled", () => {
    expect(hooksEnabledFrom(Settings.parse({ ...base, hooks: { enabled: true } }))).toBe(true);
  });

  test("hooks.enabled: false → disabled", () => {
    expect(hooksEnabledFrom(Settings.parse({ ...base, hooks: { enabled: false } }))).toBe(false);
  });
});

describe("saveSettings", () => {
  test("writes a file that loadSettings round-trips", () => {
    const p = join(mkdtempSync(join(tmpdir(), "norma-save-")), "settings.json");
    const s: Settings = { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, plugins: { enabled: ["a"] } };
    saveSettings(p, s);
    expect(loadSettings(p)).toEqual(s);
  });

  test("throws on an invalid object (bad schemaVersion) and does not write", () => {
    const p = join(mkdtempSync(join(tmpdir(), "norma-save-")), "settings.json");
    expect(() => saveSettings(p, { schemaVersion: 1, provider: { type: "codex-oauth", model: "gpt-5.4" } } as unknown as Settings)).toThrow();
  });
});

describe("setProviderModel / setReasoningEffort (norma model CLI's pure transforms)", () => {
  test("setProviderModel changes only provider.model, preserving every other field", () => {
    const s: Settings = { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol", reasoningEffort: "high" }, plugins: { enabled: ["a"] } };
    const next = setProviderModel(s, "gpt-5.6-luna");
    expect(next.provider).toEqual({ type: "codex-oauth", model: "gpt-5.6-luna", reasoningEffort: "high" });
    expect(next.plugins).toEqual({ enabled: ["a"] });
  });

  test("setProviderModel preserves openai-compatible's baseUrl", () => {
    const s: Settings = { schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.2", baseUrl: "https://x" } };
    const next = setProviderModel(s, "gpt-5.9");
    expect(next.provider).toEqual({ type: "openai-compatible", model: "gpt-5.9", baseUrl: "https://x" });
  });

  test("setReasoningEffort sets/clears provider.reasoningEffort, preserving model", () => {
    const s: Settings = { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } };
    const withEffort = setReasoningEffort(s, "xhigh");
    expect(withEffort.provider).toEqual({ type: "codex-oauth", model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
    const cleared = setReasoningEffort(withEffort, undefined);
    expect(cleared.provider.model).toBe("gpt-5.6-sol");
    expect(cleared.provider.reasoningEffort).toBeUndefined();
  });

  test("both transforms produce Settings.parse-valid output", () => {
    const s: Settings = { schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } };
    expect(() => Settings.parse(setReasoningEffort(setProviderModel(s, "gpt-5.6-terra"), "max"))).not.toThrow();
  });
});

describe("setOutputStyle (CC-parity output styles: the active style name)", () => {
  test("setOutputStyle sets and clears the key, preserving other fields", () => {
    const base = { schemaVersion: 2, provider: { type: "codex-oauth", model: "x" } } as any;
    const set = setOutputStyle(base, "proactive");
    expect(set.outputStyle).toBe("proactive");
    expect(set.provider).toEqual(base.provider); // untouched
    expect(setOutputStyle(set, undefined).outputStyle).toBeUndefined(); // cleared
    expect(setOutputStyle(set, "default").outputStyle).toBeUndefined();  // "default" clears it
  });

  test("Settings accepts an outputStyle string", () => {
    const { Settings } = require("../src/settings");
    expect(Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" }, outputStyle: "learning" }).outputStyle).toBe("learning");
  });
});

describe("permission directories", () => {
  test("Settings accepts an optional permissions.additionalDirectories block", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, permissions: { additionalDirectories: ["~/x"] } });
    expect(loadSettings(p).permissions?.additionalDirectories).toEqual(["~/x"]);
  });

  test("loadPermissionDirs merges user + project + local, expands ~, dedups (trusted project)", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-perm-home-"));
    const project = mkdtempSync(join(tmpdir(), "norma-perm-proj-"));
    wf(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, permissions: { additionalDirectories: ["~/shared"] } }));
    mkdirSync(join(project, ".norma"), { recursive: true });
    wf(join(project, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/data", "~/shared"] } }));
    wf(join(project, ".norma", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/tmp/local-grant"] } }));
    // committed .norma/settings.json only merges when the project is trusted — see
    // "loadPermissionDirs trust gating" below for the untrusted-gates-it-out coverage.
    const dirs = loadPermissionDirs(home, project, true);
    const { homedir } = require("node:os");
    expect(dirs).toContain(join(homedir(), "shared"));
    expect(dirs).toContain("/opt/data");
    expect(dirs).toContain("/tmp/local-grant");
    expect(dirs.filter((d) => d === join(homedir(), "shared"))).toHaveLength(1); // deduped
  });

  test("loadPermissionDirs tolerates missing files and missing blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-perm-h2-"));
    expect(loadPermissionDirs(home)).toEqual([]); // nothing configured
  });

  test("addLocalDir appends to settings.local.json without duplicates", () => {
    const project = mkdtempSync(join(tmpdir(), "norma-perm-add-"));
    addLocalDir(project, "/opt/one");
    addLocalDir(project, "/opt/one"); // dup ignored
    addLocalDir(project, "/opt/two");
    const local = JSON.parse(require("node:fs").readFileSync(join(project, ".norma", "settings.local.json"), "utf8"));
    expect(local.permissions.additionalDirectories).toEqual(["/opt/one", "/opt/two"]);
  });
});

describe("loadPermissionDirs trust gating", () => {
  function scaffold() {
    const home = mkdtempSync(join(tmpdir(), "norma-tg-home-"));
    const project = mkdtempSync(join(tmpdir(), "norma-tg-proj-"));
    mkdirSync(join(project, ".norma"), { recursive: true });
    wf(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" }, permissions: { additionalDirectories: ["/opt/user-dir"] } }));
    wf(join(project, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/committed-dir"] } }));       // committed → trust-gated
    wf(join(project, ".norma", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/local-dir"] } }));    // fix-wave A2: local is ALSO trust-gated now (a repo can force-commit one)
    return { home, project };
  }

  test("UNtrusted project: BOTH committed settings.json and settings.local.json are IGNORED; only user-global still applies (fix-wave A2: gitignore is not a trust boundary)", () => {
    const { home, project } = scaffold();
    const dirs = loadPermissionDirs(home, project, false);
    expect(dirs).toContain("/opt/user-dir");    // user global — always
    expect(dirs).not.toContain("/opt/local-dir");     // local — gated out when untrusted too
    expect(dirs).not.toContain("/opt/committed-dir"); // committed — gated out when untrusted
  });

  test("TRUSTED project: committed settings.json AND settings.local.json now apply", () => {
    const { home, project } = scaffold();
    const dirs = loadPermissionDirs(home, project, true);
    expect(dirs).toContain("/opt/committed-dir");
    expect(dirs).toContain("/opt/user-dir");
    expect(dirs).toContain("/opt/local-dir");
  });

  test("SECURITY: an untrusted committed settings.json cannot self-grant a broad root", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-tg-h2-"));
    const project = mkdtempSync(join(tmpdir(), "norma-tg-p2-"));
    mkdirSync(join(project, ".norma"), { recursive: true });
    wf(join(project, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/", "~"] } }));
    const { homedir } = require("node:os");
    const untrusted = loadPermissionDirs(home, project, false);
    expect(untrusted).not.toContain("/");
    expect(untrusted).not.toContain(homedir());
    const trusted = loadPermissionDirs(home, project, true);
    expect(trusted).toContain("/"); // only once the user trusts the folder
  });

  test("default projectTrusted is false (fail-closed)", () => {
    const { home, project } = scaffold();
    expect(loadPermissionDirs(home, project)).not.toContain("/opt/committed-dir");
  });
});
