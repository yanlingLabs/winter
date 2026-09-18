import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, loadPermissionDirs, addLocalDir, saveSettings, Settings, REASONING_EFFORTS, CLIENT_EFFORTS, isClientEffort, wireEffort, clientEffortEligible, setProviderModel, setReasoningEffort, hooksEnabledFrom, setOutputStyle, workflowsEnabledFrom, keywordTriggerEnabledFrom, cleanerEnabledFrom, computerUseEnabledFrom, lspEnabledFrom, winterOptionsFromSettings, DEFAULT_WINTER_IDLE_TIMEOUT_SEC, handoffCrossRuntimeEnabled, officialSubscriptionAuthEnabled, officialSubscriptionAuthFlagInert, DEFAULT_PROVIDER, pinsFor, setModelRole, modelRoleInfo, setSkillDenied, skillDenyRule, MODEL_ROLES, roleEffortFor, roleAcceptsClientEffort } from "../src/settings";
import { ModelRole as ProtocolModelRole } from "@yanlinglabs/winter-protocol";
import { mkdirSync, writeFileSync as wf } from "node:fs";
import { UNSTATED_TAG, type ModelTag } from "../src/runtime-sdk/model-tag";
import { setPluginEnabled } from "../src/plugins/lifecycle";

// WS-20: the pre-migration default bare id — used ONLY inside a raw v2 (or v1) fixture that
// exercises `loadSettings`'s OWN migration; every v3 fixture below uses `DEFAULT_PROVIDER.model`
// (a tag) instead. `DEFAULT_CODEX_MODEL` itself is deleted along with `CODEX_MODELS`.
const LEGACY_DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/** A plain test literal known to be tag-shaped, asserted as `ModelTag` for `toEqual`/`toBe` against
 *  a branded field — these fixtures are hand-written to already be valid tags, so this is a type
 *  assertion, never a runtime validation (mirrors every other test file's identical `tag()` helper
 *  under this arc). */
const tag = (s: string): ModelTag => s as ModelTag;

function tmpSettings(content: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), "winter-set-")), "settings.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe("loadSettings", () => {
  // WS-20 (review round 2, M5): `loadSettings`'s migration is now IN-MEMORY ONLY by default
  // (`persistMigration` defaults to `false`) — the daemon boot hook is the only caller that opts in
  // (with presence in hand); every other caller (the CLI, every test below that doesn't pass
  // `persistMigration: true`) gets the SAME migrated `Settings` object back, but the file on disk is
  // left exactly as found.
  test("migrates schemaVersion 1 → 3 with codex-oauth default IN MEMORY, without persistMigration", () => {
    const p = tmpSettings({ schemaVersion: 1 });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.provider).toEqual(DEFAULT_PROVIDER); // gpt-5.4 fully deprecated — default points at the current tag
    expect(JSON.parse(readFileSync(p, "utf8")).schemaVersion).toBe(1); // NOT persisted — this is the "CLI path"
  });

  test("migrates schemaVersion 1 → 3 AND persists, given persistMigration: true (the daemon-boot path)", () => {
    const p = tmpSettings({ schemaVersion: 1 });
    const s = loadSettings(p, { persistMigration: true });
    expect(s.schemaVersion).toBe(3);
    expect(s.provider).toEqual(DEFAULT_PROVIDER);
    expect(JSON.parse(readFileSync(p, "utf8")).schemaVersion).toBe(3); // migration persisted
  });

  // WS-20 (spec §5 rule 3): a v2 `openai-compatible` provider migrates to an `openai/` tag, and
  // its `baseUrl` moves into the sibling `providers.openai.baseUrl` block.
  test("v2 openai-compatible settings migrate to v3: openai/ tag + providers.openai.baseUrl", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.provider).toEqual({ model: tag("openai/gpt-5.6-sol") });
    expect(s.providers?.openai?.baseUrl).toBe("https://api.openai.com/v1");
    // In-memory only by default — no backup and no persisted v3 file (the "CLI path").
    expect(existsSync(`${p}.bak-pre-ws20`)).toBe(false);
    expect(JSON.parse(readFileSync(p, "utf8")).schemaVersion).toBe(2);
  });

  test("v2 openai-compatible settings, given persistMigration: true, back up the pre-migration file once (spec §5)", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "openai-compatible", model: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1" } });
    const s = loadSettings(p, { persistMigration: true });
    expect(s.schemaVersion).toBe(3);
    expect(existsSync(`${p}.bak-pre-ws20`)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).schemaVersion).toBe(3);
  });

  // WS-20 (review round 2, nit h): a FRESH schemaVersion-1 home never had real provider info to
  // lose — the backup must never fire for it, with or without persistMigration.
  test("nit(h): a fresh schemaVersion-1 home is never backed up, even with persistMigration: true", () => {
    const p = tmpSettings({ schemaVersion: 1 });
    loadSettings(p, { persistMigration: true });
    expect(existsSync(`${p}.bak-pre-ws20`)).toBe(false);
  });

  // SP-approvals T10 (spec §7): permissions.dangerousDomains.added — the user-added half of
  // web_fetch's dangerous-domain floor (agent/dangerous-domains.ts's SHIPPED_DANGEROUS_DOMAINS is
  // the other, immutable half). Additive optional key — absent means "no user additions".
  test("permissions.dangerousDomains.added round-trips through the schema", () => {
    const p = tmpSettings({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: LEGACY_DEFAULT_CODEX_MODEL },
      permissions: { dangerousDomains: { added: ["evil-example.net", "exfil.example.org"] } },
    });
    const s = loadSettings(p);
    expect(s.permissions?.dangerousDomains?.added).toEqual(["evil-example.net", "exfil.example.org"]);
  });

  test("permissions.dangerousDomains absent is valid (no user additions)", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "codex-oauth", model: LEGACY_DEFAULT_CODEX_MODEL } });
    expect(loadSettings(p).permissions?.dangerousDomains).toBeUndefined();
  });

  test("permissions.dangerousDomains.added rejects a non-array value", () => {
    const p = tmpSettings({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: LEGACY_DEFAULT_CODEX_MODEL },
      permissions: { dangerousDomains: { added: "not-an-array" } },
    });
    expect(() => loadSettings(p)).toThrow(/settings/);
  });

  test("corrupt settings throw a readable error", () => {
    const p = tmpSettings({ schemaVersion: 2, provider: { type: "telepathy" } });
    expect(() => loadSettings(p)).toThrow(/settings/);
  });

  test("missing settings file throws a readable error", () => {
    expect(() => loadSettings(join(mkdtempSync(join(tmpdir(), "winter-set-")), "settings.json"))).toThrow(/winter daemon run/);
  });

  test("legacy v1-app settings (no schemaVersion) migrate, preserving v1 keys — in the PARSED result and, given persistMigration: true, on disk", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p, { persistMigration: true });
    expect(s.schemaVersion).toBe(3);
    expect(s.provider.model).toBe(DEFAULT_PROVIDER.model);
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.legacyCustom).toEqual({ provider: "disabled" }); // v1 data preserved on disk
    expect(onDisk.schemaVersion).toBe(3);
  });

  test("without persistMigration, a legacy v1-app file migrates in the PARSED result only — nothing written", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.provider.model).toBe(DEFAULT_PROVIDER.model);
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.schemaVersion).toBeUndefined(); // untouched — the original v1 fixture has none
  });

  test("v1→v2 migration preserves unknown fields on disk, given persistMigration: true", () => {
    const p = tmpSettings({ schemaVersion: 1, custom: true });
    loadSettings(p, { persistMigration: true });
    expect(JSON.parse(readFileSync(p, "utf8")).custom).toBe(true);
  });

  test("v1→v2 migration preserves a permissions block in the parsed result, and on disk given persistMigration: true", () => {
    const p = tmpSettings({ schemaVersion: 1, permissions: { additionalDirectories: ["~/kept", "/opt/kept"] } });
    const s = loadSettings(p, { persistMigration: true });
    expect(s.schemaVersion).toBe(3);
    expect(s.permissions?.additionalDirectories).toEqual(["~/kept", "/opt/kept"]);
    // and on disk:
    const onDisk = JSON.parse(require("node:fs").readFileSync(p, "utf8"));
    expect(onDisk.permissions.additionalDirectories).toEqual(["~/kept", "/opt/kept"]);
  });

  test("legacy no-schemaVersion file with permissions migrates and keeps them", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" }, permissions: { additionalDirectories: ["/opt/x"] } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.permissions?.additionalDirectories).toEqual(["/opt/x"]);
  });

  test("mcpServers parses; absent → undefined; legacy migration keeps working", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], env: { X: "1" } } } });
    if (!s.mcpServers) throw new Error("mcpServers must be defined");
    // Daemon settings surface batch 3 (item 3b): a `type`-less entry (the pre-item-3b shape every
    // home's settings.json already has on disk) normalizes to stdio -- byte-identical acceptance,
    // just now an explicit discriminant on the parsed object.
    const everything = s.mcpServers["everything"]!;
    expect(everything.type).toBe("stdio");
    if (everything.type !== "stdio") throw new Error("unreachable");
    expect(everything.command).toBe("npx");
    const none = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } });
    expect(none.mcpServers).toBeUndefined();
  });

  test("mcpServers accepts HTTP and SSE entries too (batch 3 item 3b), field-for-field", () => {
    const s = Settings.parse({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      mcpServers: {
        // Ruling (fix wave item 6): a credential-shaped header is now REFUSED at this door — see
        // the dedicated describe block below — so this fixture uses a benign header instead.
        remoteHttp: { type: "http", url: "https://example.com/mcp", headers: { "X-Request-Id": "abc123" } },
        remoteSse: { type: "sse", url: "https://example.com/sse" },
      },
    });
    expect(s.mcpServers!["remoteHttp"]).toEqual({ type: "http", url: "https://example.com/mcp", headers: { "X-Request-Id": "abc123" } });
    expect(s.mcpServers!["remoteSse"]).toEqual({ type: "sse", url: "https://example.com/sse" });
  });

  test("a malformed mcpServers entry is refused with a useful, field-pointing message", () => {
    // Missing `command` on a type-less (→ stdio) entry.
    const noCommand = Settings.safeParse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, mcpServers: { bad: {} } });
    expect(noCommand.success).toBe(false);
    if (!noCommand.success) expect(noCommand.error.issues.some((i) => i.path.join(".") === "mcpServers.bad.command")).toBe(true);

    // Missing `url` on an http entry.
    const noUrl = Settings.safeParse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, mcpServers: { bad: { type: "http" } } });
    expect(noUrl.success).toBe(false);
    if (!noUrl.success) expect(noUrl.error.issues.some((i) => i.path.join(".") === "mcpServers.bad.url")).toBe(true);

    // A non-URL `url` string.
    const badUrl = Settings.safeParse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, mcpServers: { bad: { type: "http", url: "not-a-url" } } });
    expect(badUrl.success).toBe(false);
    if (!badUrl.success) expect(badUrl.error.issues.some((i) => i.path.join(".") === "mcpServers.bad.url")).toBe(true);

    // An unrecognized `type` discriminant.
    const badType = Settings.safeParse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, mcpServers: { bad: { type: "grpc", url: "https://example.com" } } });
    expect(badType.success).toBe(false);
  });

  // RULING (fix wave, pre-merge review, item 6): `<home>/settings.json` is model-readable, so a
  // bearer token or API key sitting in an HTTP/SSE MCP server's `headers` is agent-exfiltratable.
  // Refused case-insensitively at the settings door until env-var indirection or a Keychain locator
  // exists for this field — a deliberate, documented narrowing of what the pinned agent SDK's own
  // McpHttpServerConfig/McpSSEServerConfig accept for `headers`.
  describe("MCP headers must not carry credentials yet (ruling, item 6)", () => {
    function withHeader(type: "http" | "sse", headers: Record<string, string>) {
      return Settings.safeParse({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
        mcpServers: { bad: { type, url: "https://example.com/mcp", headers } },
      });
    }

    test("refuses the four well-known credential header names, case-insensitively, on both http and sse", () => {
      for (const type of ["http", "sse"] as const) {
        for (const name of ["Authorization", "authorization", "X-Api-Key", "x-api-key", "Cookie", "COOKIE", "Proxy-Authorization", "proxy-authorization"]) {
          const result = withHeader(type, { [name]: "sk-should-be-refused" });
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error.issues.some((i) => i.path.join(".") === `mcpServers.bad.headers.${name}`)).toBe(true);
            // The error names the rule and points at the alternative (env-var indirection).
            expect(result.error.issues[0]?.message).toContain("credential-shaped");
            expect(result.error.issues[0]?.message).toContain("${env:VAR}");
          }
        }
      }
    });

    test("refuses any header name containing \"token\" or \"secret\" anywhere, case-insensitively", () => {
      for (const name of ["X-Auth-Token", "x-secret-key", "My-Token-Header", "SECRET"]) {
        expect(withHeader("http", { [name]: "value" }).success).toBe(false);
      }
    });

    test("a benign header still passes through unchanged, on both legs' server shapes", () => {
      const result = withHeader("http", { "X-Request-Id": "abc123", Accept: "application/json" });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("unreachable");
      const entry = result.data.mcpServers?.bad;
      if (entry?.type !== "http") throw new Error("unreachable");
      expect(entry.headers).toEqual({ "X-Request-Id": "abc123", Accept: "application/json" });
    });

    test("no headers at all still parses (absent stays absent)", () => {
      const result = Settings.safeParse({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
        mcpServers: { bad: { type: "http", url: "https://example.com/mcp" } },
      });
      expect(result.success).toBe(true);
    });

    // CORRECTED RULING (read-door follow-up): `<home>/settings.json` can be hand-edited by a human
    // OUTSIDE Winter entirely, and `loadSettings` refusing to LOAD such a file is far worse than the
    // leak the WRITE door guards against — `daemon.ts`'s boot hook treats any `loadSettings` throw
    // as "settings unavailable, agent disabled", so ONE hand-edited header on ONE configured MCP
    // server used to disable EVERY session on the machine. The WRITE door (`saveSettings`, and any
    // direct `Settings.parse`/`safeParse` — the four tests above) still refuses UNCONDITIONALLY;
    // only the READ door (`loadSettings`) now strips the offending header and keeps loading.
    const SENTINEL = "Bearer sk-SENTINEL-9f8e7d-DO-NOT-LEAK";

    describe("loadSettings strips instead of refusing (the bug this ruling corrects)", () => {
      test("RED FIRST (was refused before the fix): loadSettings SUCCEEDS on a hand-edited file with a credential-shaped header — the header is gone from the parsed value, the rest of the entry survives, exactly one line is logged", () => {
        const p = tmpSettings({
          schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
          mcpServers: {
            bad: { type: "http", url: "https://example.com/mcp", headers: { Authorization: SENTINEL, "X-Request-Id": "abc123" } },
          },
        });
        const errSpy = spyOn(console, "error").mockImplementation(() => {});
        let s: Settings;
        let lines: string[];
        try {
          s = loadSettings(p); // used to throw here — see the deleted test this one replaces
          lines = errSpy.mock.calls.map((c) => String(c[0])); // read BEFORE mockRestore() — mockRestore clears call history
        } finally {
          errSpy.mockRestore();
        }
        const entry = s.mcpServers?.bad;
        if (entry?.type !== "http") throw new Error("unreachable");
        expect(entry.headers).toEqual({ "X-Request-Id": "abc123" }); // offending key gone; benign header + url survive
        expect(entry.url).toBe("https://example.com/mcp");
        const offending = lines.filter((l) => l.includes('mcp server "bad"') && l.includes('header "Authorization"'));
        expect(offending.length).toBe(1); // exactly one stderr line for this offending entry
        expect(offending[0]).toContain("credential-shaped");
        expect(lines.some((l) => l.includes(SENTINEL))).toBe(false); // the header VALUE never appears in any log line
      });

      test("multiple offending headers on one entry each get their own logged line; a benign header on the same entry survives untouched", () => {
        const p = tmpSettings({
          schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
          mcpServers: {
            bad: { type: "sse", url: "https://example.com/sse", headers: { "X-Auth-Token": SENTINEL, Cookie: "c", Accept: "application/json" } },
          },
        });
        const errSpy = spyOn(console, "error").mockImplementation(() => {});
        let s: Settings;
        let lines: string[];
        try {
          s = loadSettings(p);
          lines = errSpy.mock.calls.map((c) => String(c[0])); // read BEFORE mockRestore()
        } finally {
          errSpy.mockRestore();
        }
        const entry = s.mcpServers?.bad;
        if (entry?.type !== "sse") throw new Error("unreachable");
        expect(entry.headers).toEqual({ Accept: "application/json" });
        expect(lines.filter((l) => l.includes('header "X-Auth-Token"')).length).toBe(1);
        expect(lines.filter((l) => l.includes('header "Cookie"')).length).toBe(1);
      });

      test("a stdio entry's stray headers field is never treated as a credential drop (headers is not part of the stdio shape at all)", () => {
        const p = tmpSettings({
          schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
          mcpServers: { bad: { type: "stdio", command: "true", headers: { Authorization: SENTINEL } } },
        });
        const errSpy = spyOn(console, "error").mockImplementation(() => {});
        try {
          loadSettings(p);
          expect(errSpy.mock.calls.some((c) => String(c[0]).includes("credential-shaped"))).toBe(false);
        } finally {
          errSpy.mockRestore();
        }
      });

      test("logs at most once per (file, server, header) across repeated loadSettings calls on the same path — no per-call log spam", () => {
        const p = tmpSettings({
          schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
          mcpServers: { bad: { type: "http", url: "https://example.com/mcp", headers: { Authorization: SENTINEL } } },
        });
        const errSpy = spyOn(console, "error").mockImplementation(() => {});
        try {
          loadSettings(p);
          loadSettings(p);
          loadSettings(p);
          const offending = errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('header "Authorization"'));
          expect(offending.length).toBe(1);
        } finally {
          errSpy.mockRestore();
        }
      });
    });

    // The WRITE door: unchanged, still refuses unconditionally — pinned directly at `saveSettings`
    // itself (not just the schema `Settings.safeParse` tests above), since that IS the door a real
    // settings-writing RPC (`mcp.enable`/`disable`, `setModelRole`, `setSkillDenied`, plugin
    // enable/disable, …) goes through.
    test("saveSettings still refuses a credential-shaped header, naming the rule and the alternative, never echoing the value", () => {
      const p = tmpSettings({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } });
      // Built by hand (never through `Settings.parse`, which would itself throw here) — the same
      // shape a caller who skipped validation, or round-tripped a hand-built object, could hand in.
      const bad = {
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
        mcpServers: { bad: { type: "http", url: "https://example.com/mcp", headers: { Authorization: SENTINEL } } },
      } as unknown as Settings;
      expect(() => saveSettings(p, bad)).toThrow(/credential-shaped/);
      expect(() => saveSettings(p, bad)).toThrow(/\$\{env:VAR\}/);
      try {
        saveSettings(p, bad);
        throw new Error("unreachable");
      } catch (err) {
        expect((err as Error).message).not.toContain(SENTINEL);
      }
    });
  });

  test("reviewer config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, reviewer: { enabled: true, model: "codex-oauth/gpt-5.4-mini", allow: ["git status"] } });
    expect(s.reviewer).toEqual({ enabled: true, model: tag("codex-oauth/gpt-5.4-mini"), allow: ["git status"] });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).reviewer).toBeUndefined();
  });

  test("legacy migration keeps working with reviewer field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.reviewer).toBeUndefined();
  });

  // Phase 5e T4: reviewer.classes — additive per-class on/off, subordinate to reviewer.enabled.
  const base54 = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.4" } };

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
    expect(s.schemaVersion).toBe(3);
    expect(s.reviewer?.classes).toBeUndefined();
  });

  test("plugins config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, plugins: { enabled: ["a"], disabled: ["b"] } });
    expect(s.plugins).toEqual({ enabled: ["a"], disabled: ["b"] });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).plugins).toBeUndefined();
  });

  test("legacy migration keeps working with plugins field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.plugins).toBeUndefined();
  });

  test("toolSearch config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, toolSearch: { enabled: true, deferThreshold: 20 } });
    expect(s.toolSearch).toEqual({ enabled: true, deferThreshold: 20 });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).toolSearch).toBeUndefined();
  });

  test("toolSearch.deferExternals parses 'count'/'always'; absent → undefined; bad value rejected", () => {
    const count = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, toolSearch: { deferExternals: "count" } });
    expect(count.toolSearch).toEqual({ deferExternals: "count" });
    const always = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, toolSearch: { enabled: true, deferThreshold: 20, deferExternals: "always" } });
    expect(always.toolSearch).toEqual({ enabled: true, deferThreshold: 20, deferExternals: "always" });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, toolSearch: {} }).toolSearch?.deferExternals).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, toolSearch: { deferExternals: "sometimes" } })).toThrow();
  });

  test("legacy migration keeps working with toolSearch field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.toolSearch).toBeUndefined();
  });

  test("worktree config parses; absent → undefined; bad baseRef rejected", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, worktree: { baseRef: "fresh" } });
    expect(s.worktree).toEqual({ baseRef: "fresh" });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).worktree).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, worktree: { baseRef: "bogus" } })).toThrow();
  });

  test("legacy migration keeps working with worktree field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.worktree).toBeUndefined();
  });

  test("subagents config parses; absent → undefined; non-positive maxConcurrent rejected", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxConcurrent: 2 } });
    expect(s.subagents).toEqual({ maxConcurrent: 2 });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).subagents).toBeUndefined();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxConcurrent: 0 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxConcurrent: -1 } })).toThrow();
  });

  // 4h-i Task 3: subagents.maxDepth — CC parity (CC allows nesting depth up to 5; Winter's engine
  // defaults to 2 when this is unset — see engine.ts's `subagentMaxDepth ?? 2`).
  test("subagents.maxDepth parses (1-5 inclusive); absent → undefined; out-of-range/non-integer rejected", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxDepth: 3 } });
    expect(s.subagents).toEqual({ maxDepth: 3 });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).subagents).toBeUndefined();

    // boundaries: 1 and 5 both accepted
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxDepth: 1 } }).subagents).toEqual({ maxDepth: 1 });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxDepth: 5 } }).subagents).toEqual({ maxDepth: 5 });

    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxDepth: 0 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxDepth: 6 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxDepth: 2.5 } })).toThrow();

    // maxConcurrent and maxDepth coexist independently within the same subagents block
    const both = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, subagents: { maxConcurrent: 2, maxDepth: 4 } });
    expect(both.subagents).toEqual({ maxConcurrent: 2, maxDepth: 4 });
  });

  // No-timeout task (user rule 2026-07-12): subagents.timeoutMs is the EXPLICIT wall-clock
  // opt-in (ABSENT = no wall clock at all — the new default); subagents.stallTimeoutMs overrides
  // the progress-stall watchdog window (ABSENT = the manager's 600000 default). Both hot via
  // daemon.ts's live getters.
  test("subagents.timeoutMs + stallTimeoutMs parse (positive ints); absent → undefined (no wall clock / stall default); zero/negative/non-integer rejected", () => {
    const base = { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } };

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
    expect(s.schemaVersion).toBe(3);
    expect(s.subagents).toBeUndefined();
  });

  // 4g Task 6: webSearch.provider defaults (unset) to Brave; "brave" is the only accepted literal
  // today (forward-room for other backends later).
  test("webSearch config parses; absent → undefined; non-brave provider rejected", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, webSearch: { provider: "brave" } });
    expect(s.webSearch).toEqual({ provider: "brave" });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).webSearch).toBeUndefined();
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, webSearch: {} }).webSearch).toEqual({});
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, webSearch: { provider: "disabled" } })).toThrow();
  });

  test("legacy migration keeps working with webSearch field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.webSearch).toBeUndefined();
  });

  test("provider.reasoningEffort parses on both provider variants; absent → undefined", () => {
    const codex = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: "high" } });
    expect(codex.provider.reasoningEffort).toBe("high");
    const openai = Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.2", reasoningEffort: "xhigh" }, providers: { openai: { baseUrl: "https://x" } } });
    expect(openai.provider.reasoningEffort).toBe("xhigh");
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }).provider.reasoningEffort).toBeUndefined();
  });

  test("every documented reasoning-effort slug parses; an invalid slug is rejected", () => {
    expect(REASONING_EFFORTS).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    for (const effort of REASONING_EFFORTS) {
      const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: effort } });
      expect(s.provider.reasoningEffort).toBe(effort);
    }
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: "bogus" } })).toThrow();
  });

  // Task 1 (provider-correctness, 2026-07-31): pins the live bug this task exists to fix.
  // "ultra" was added to REASONING_EFFORTS on 2026-07-10 from a reading of the live /models
  // catalogue that was never checked against the request validator. Effort is GLOBAL and
  // HOT-RELOADED (providers/manager.ts's live resolver re-reads settings.json every turn), so
  // `winter model --effort ultra` doesn't fail at set-time — it silently PERSISTS, and then breaks
  // EVERY session with an opaque HTTP 400 one turn later. Measured live against the Codex OAuth
  // endpoint this session (do not re-derive, do not weaken): "ultra" is rejected by a DIFFERENT,
  // GLOBAL enum layer (`invalid_value`, model-agnostic) than per-model rejections; "none" is
  // genuinely honoured on all three gpt-5.6 models — the server echoes `effort: "none"` in both
  // response.created and response.completed, emits no reasoning item, and reports 0 reasoning
  // tokens (the same model at `max` reports 42, proving the counter is live, not always zero).
  test("ultra must never be wire-valid again; none must always be (the live 400 this task fixes)", () => {
    expect(REASONING_EFFORTS as readonly string[]).not.toContain("ultra");
    expect(REASONING_EFFORTS as readonly string[]).toContain("none");
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: "ultra" } })).toThrow();
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: "none" } });
    expect(s.provider.reasoningEffort).toBe("none");

    // The actual `winter model --effort ultra` path: setReasoningEffort + saveSettings (which
    // validates before writing). Before this task's fix, this round-trip SUCCEEDED and wrote
    // "ultra" to settings.json on disk — exactly the write that then 400s every session's next
    // turn against the live endpoint.
    const p = tmpSettings({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } });
    expect(() => saveSettings(p, setReasoningEffort(loadSettings(p), "ultra" as any))).toThrow();
  });

  // ----------------------------------------------------------------------------------------------
  // provider-correctness T5 — the WINTER-LEVEL tier vocabulary (`CLIENT_EFFORTS`), which lives beside
  // `REASONING_EFFORTS` precisely so the two are read together and never conflated. `REASONING_EFFORTS`
  // is what the endpoint's request validator accepts; `CLIENT_EFFORTS` is what Winter offers on top and
  // TRANSLATES away before a request exists. The two must stay disjoint, and `wireEffort` must be a
  // TOTAL function into the first set — those are the only two properties that keep `ultra` off the wire.
  // ----------------------------------------------------------------------------------------------
  test("CLIENT_EFFORTS is the tier set, and it is DISJOINT from the wire set", () => {
    expect(CLIENT_EFFORTS).toEqual(["ultra"]);
    for (const tier of CLIENT_EFFORTS) {
      expect(REASONING_EFFORTS as readonly string[]).not.toContain(tier);
    }
    for (const wire of REASONING_EFFORTS) {
      expect(CLIENT_EFFORTS as readonly string[]).not.toContain(wire);
    }
  });

  test("a client tier is a per-SESSION selector — it is still refused as a GLOBAL settings value", () => {
    // `settings.provider.reasoningEffort` is the daemon-wide default and goes on the wire verbatim
    // for every session with no override. A tier has no meaning there (nothing would translate it
    // for the sessions that inherit it), so the settings schema keeps refusing it — the Task 1 fix
    // is untouched by this task.
    for (const tier of CLIENT_EFFORTS) {
      expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: tier } })).toThrow();
    }
  });

  test("wireEffort is TOTAL into the wire set: a tier maps to max, a wire effort is identity, unset stays unset", () => {
    expect(wireEffort("ultra")).toBe("max");
    for (const wire of REASONING_EFFORTS) expect(wireEffort(wire)).toBe(wire);
    expect(wireEffort(undefined)).toBeUndefined();
    // The property that actually matters — anything this returns is either absent or wire-valid.
    // A second tier added to CLIENT_EFFORTS without a mapping row would fail HERE rather than
    // silently reaching a request body.
    for (const effort of [...CLIENT_EFFORTS, ...REASONING_EFFORTS]) {
      expect(REASONING_EFFORTS as readonly string[]).toContain(wireEffort(effort)!);
    }
  });

  test("isClientEffort recognises exactly the tiers — never a wire effort, never junk", () => {
    for (const tier of CLIENT_EFFORTS) expect(isClientEffort(tier)).toBe(true);
    for (const wire of REASONING_EFFORTS) expect(isClientEffort(wire)).toBe(false);
    for (const junk of ["", "ULTRA", "ultra ", "minimal", undefined]) expect(isClientEffort(junk)).toBe(false);
  });

  // FAIL-CLOSED, unlike engine.ts's `resolveMode` (which defaults an unrecognised mode to "code").
  // They agree on every mode that exists today; they disagree on a mode nobody has written yet, and
  // for a tier that changes the system prompt the safe default is "not this one".
  test("clientEffortEligible is a fail-closed code-only allowlist", () => {
    expect(clientEffortEligible(undefined)).toBe(true);  // the store-wide `mode ?? "code"` convention
    expect(clientEffortEligible("code")).toBe(true);
    for (const mode of ["chat", "dispatch", "cowork", "", "CODE", "something-new"]) {
      expect(clientEffortEligible(mode)).toBe(false);
    }
  });

  test("hooks config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, hooks: { enabled: false } });
    expect(s.hooks).toEqual({ enabled: false });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).hooks).toBeUndefined();
  });

  test("legacy migration keeps working with hooks field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.hooks).toBeUndefined();
  });

  // Phase 5f Task 4: lsp.enabled/idleShutdownMs — mirrors hooks/toolSearch/subagents' own
  // optional-nested-block shape (unknown keys stripped, wrong-typed known keys throw).
  test("lsp config parses (both fields); absent block → undefined", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { enabled: false, idleShutdownMs: 60_000 } });
    expect(s.lsp).toEqual({ enabled: false, idleShutdownMs: 60_000 });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).lsp).toBeUndefined();
  });

  test("lsp: a partial object (one field set) round-trips exactly — the other field stays absent, not defaulted-in at the settings layer", () => {
    const enabledOnly = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { enabled: true } });
    expect(enabledOnly.lsp).toEqual({ enabled: true });
    expect(enabledOnly.lsp).not.toHaveProperty("idleShutdownMs");
    const idleOnly = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { idleShutdownMs: 1000 } });
    expect(idleOnly.lsp).toEqual({ idleShutdownMs: 1000 });
    expect(idleOnly.lsp).not.toHaveProperty("enabled");
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: {} }).lsp).toEqual({});
  });

  test("lsp: an unrecognized key inside the block is tolerated — stripped like every other zod object here, never rejects the whole settings file", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { enabled: true, maxWorkers: 4 } });
    expect(s.lsp).toEqual({ enabled: true });
    expect(s.lsp).not.toHaveProperty("maxWorkers");
  });

  test("lsp: a wrong-typed known key throws (same idiom as subagents.maxConcurrent / worktree.baseRef)", () => {
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { enabled: "yes" } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { idleShutdownMs: -1 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { idleShutdownMs: 0 } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, lsp: { idleShutdownMs: "60000" } })).toThrow();
  });

  test("legacy migration keeps working with lsp field absent", () => {
    const p = tmpSettings({ legacyCustom: { provider: "disabled" } });
    const s = loadSettings(p);
    expect(s.schemaVersion).toBe(3);
    expect(s.lsp).toBeUndefined();
  });

  // Sparkle T5: updates.channel — beta/stable auto-update channel, read live by the app at
  // each check (no daemon restart needed — see UpdaterCoordinator.readChannelFromSettings()).
  test("updates.channel accepts stable/beta/absent and rejects junk", () => {
    const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.4" } };
    expect(Settings.safeParse({ ...base, updates: { channel: "beta" } }).success).toBe(true);
    expect(Settings.safeParse({ ...base, updates: { channel: "stable" } }).success).toBe(true);
    expect(Settings.safeParse({ ...base, updates: {} }).success).toBe(true);
    expect(Settings.safeParse({ ...base, updates: { channel: "nightly" } }).success).toBe(false);
  });

  // Task B1 (CC-parity phase 3, Workflows Track B): workflows.{enabled,keywordTrigger} — same
  // additive optional-block shape as hooks/toolSearch/lsp above (unknown keys stripped, wrong-typed
  // known keys throw); default-ON semantics for each flag are covered separately below
  // (workflowsEnabledFrom/keywordTriggerEnabledFrom).
  test("workflows config parses; absent → undefined", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, workflows: { enabled: false, keywordTrigger: true } });
    expect(s.workflows).toEqual({ enabled: false, keywordTrigger: true });
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } }).workflows).toBeUndefined();
  });
});

describe("workflowsEnabledFrom / keywordTriggerEnabledFrom (Task B1: workflows.{enabled,keywordTrigger} default-ON semantics)", () => {
  test("workflows key parses; both flags default ON when absent", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } });
    expect(workflowsEnabledFrom(s)).toBe(true);
    expect(keywordTriggerEnabledFrom(s)).toBe(true);
  });

  test("explicit false disables each independently", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, workflows: { enabled: false, keywordTrigger: true } });
    expect(workflowsEnabledFrom(s)).toBe(false);
    expect(keywordTriggerEnabledFrom(s)).toBe(true);
  });
});

describe("hooksEnabledFrom (4f: hooks.enabled default-ON semantics)", () => {
  const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.4" } };

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

describe("cleanerEnabledFrom (session-activity-hygiene T7: cleaner.enabled default-ON semantics)", () => {
  const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.4" } };

  test("cleaner block absent → enabled", () => {
    expect(cleanerEnabledFrom(Settings.parse(base))).toBe(true);
  });

  test("cleaner.enabled absent (block present, field absent) → enabled", () => {
    expect(cleanerEnabledFrom(Settings.parse({ ...base, cleaner: {} }))).toBe(true);
  });

  test("cleaner.enabled: true → enabled", () => {
    expect(cleanerEnabledFrom(Settings.parse({ ...base, cleaner: { enabled: true } }))).toBe(true);
  });

  test("cleaner.enabled: false → disabled", () => {
    expect(cleanerEnabledFrom(Settings.parse({ ...base, cleaner: { enabled: false } }))).toBe(false);
  });

  test("the flag round-trips through a real settings.json (the watcher's own read path)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "winter-cleaner-settings-")), "settings.json");
    saveSettings(p, Settings.parse({ ...base, cleaner: { enabled: false } }));
    expect(cleanerEnabledFrom(loadSettings(p))).toBe(false);
  });
});

// Minor 5e (fix wave, pre-merge review): `computerUseEnabledFrom`/`lspEnabledFrom` consolidate what
// used to be FOUR independently hand-spelled copies each (daemon.ts's boot gate + its own live
// getter, settings-apply.ts's hot-toggle closure, and ipc/server.ts's capabilities.list handler)
// into one reader apiece.
describe("computerUseEnabledFrom (Minor 5e: opt-in / default-OFF)", () => {
  const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.4" } };

  test("computerUse block absent → disabled", () => {
    expect(computerUseEnabledFrom(Settings.parse(base))).toBe(false);
  });

  test("computerUse.enabled absent (block present, field absent) → disabled", () => {
    expect(computerUseEnabledFrom(Settings.parse({ ...base, computerUse: {} }))).toBe(false);
  });

  test("computerUse.enabled: true → enabled", () => {
    expect(computerUseEnabledFrom(Settings.parse({ ...base, computerUse: { enabled: true } }))).toBe(true);
  });

  test("computerUse.enabled: false → disabled", () => {
    expect(computerUseEnabledFrom(Settings.parse({ ...base, computerUse: { enabled: false } }))).toBe(false);
  });
});

describe("lspEnabledFrom (Minor 5e: opt-out / default-ON)", () => {
  const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.4" } };

  test("lsp block absent → enabled", () => {
    expect(lspEnabledFrom(Settings.parse(base))).toBe(true);
  });

  test("lsp.enabled absent (block present, field absent) → enabled", () => {
    expect(lspEnabledFrom(Settings.parse({ ...base, lsp: {} }))).toBe(true);
  });

  test("lsp.enabled: true → enabled", () => {
    expect(lspEnabledFrom(Settings.parse({ ...base, lsp: { enabled: true } }))).toBe(true);
  });

  test("lsp.enabled: false → disabled", () => {
    expect(lspEnabledFrom(Settings.parse({ ...base, lsp: { enabled: false } }))).toBe(false);
  });
});

// Minor 5f (fix wave, pre-merge review): `MODEL_ROLES` (settings.ts) and the protocol's `ModelRole`
// enum (methods.ts) are hand-mirrored — protocol never depends on core, so there is no import to
// enforce agreement, only that schema's own doc comment saying "kept in sync by hand". This is the
// drift tripwire: every entry of the daemon's OWN list must parse through the wire enum, AND the two
// lists must carry exactly the same members (not just "core's list is a subset of protocol's" —
// either direction of drift is a real bug: a role the daemon serves that the wire schema refuses, or
// a wire role the daemon has silently stopped serving).
describe("MODEL_ROLES / protocol ModelRole parity (Minor 5f)", () => {
  test("every daemon-side role parses through the protocol's wire enum", () => {
    for (const role of MODEL_ROLES) {
      expect(ProtocolModelRole.safeParse(role).success).toBe(true);
    }
  });

  test("the two lists carry EXACTLY the same members — no drift in either direction", () => {
    expect([...MODEL_ROLES].sort()).toEqual([...ProtocolModelRole.options].sort());
  });
});

describe("saveSettings", () => {
  test("writes a file that loadSettings round-trips", () => {
    const p = join(mkdtempSync(join(tmpdir(), "winter-save-")), "settings.json");
    const s: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.4") }, plugins: { enabled: ["a"] } };
    saveSettings(p, s);
    expect(loadSettings(p)).toEqual(s);
  });

  test("throws on an invalid object (bad schemaVersion) and does not write", () => {
    const p = join(mkdtempSync(join(tmpdir(), "winter-save-")), "settings.json");
    expect(() => saveSettings(p, { schemaVersion: 1, provider: { model: "codex-oauth/gpt-5.4" } } as unknown as Settings)).toThrow();
  });

  // Item 5a (2026-09-17 plan): the round-trip merge. Ordering rule: daemon-owned keys always win;
  // unknown keys (schema-unmodeled, at ANY depth) survive untouched from whatever is currently on
  // disk. Every test below hand-writes the ON-DISK file with an unknown top-level key AND an
  // unknown key nested inside a KNOWN block (`reviewer`), then exercises a real write path that
  // never touches either, and asserts both survived.
  describe("round-trips unknown keys (item 5a)", () => {
    function diskWithUnknownKeys(p: string) {
      wf(p, JSON.stringify({
        schemaVersion: 3,
        provider: { model: "codex-oauth/gpt-5.6-sol" },
        // unknown TOP-LEVEL key — an entire block this schema has never heard of (the "hand-written
        // SDK-format block" scenario named in the plan).
        enabledPlugins: ["foo", "bar"],
        // unknown key NESTED inside a KNOWN, non-strict block — `reviewer` only models
        // enabled/model/allow/classes; `hooks` here is the claude-agent-sdk's own hook-config
        // shape, not Winter's `hooks.enabled` key, and lives inside a block Winter DOES define.
        reviewer: { enabled: true, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } },
      }, null, 2));
    }

    test("survives a setModelRole write (titles.model)", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-unknown-")), "settings.json");
      diskWithUnknownKeys(p);
      const before = loadSettings(p);
      const next = setModelRole(before, "titles.model", "codex-oauth/gpt-5.6-luna");
      saveSettings(p, next);

      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.enabledPlugins).toEqual(["foo", "bar"]);
      expect(onDisk.reviewer.hooks).toEqual({ PreToolUse: [{ matcher: "Bash", hooks: [] }] });
      expect(onDisk.reviewer.enabled).toBe(true); // the known sibling key is untouched too
      expect(onDisk.titles.model).toBe("codex-oauth/gpt-5.6-luna"); // the actual write landed
      // loadSettings still round-trips fine — the unknown keys don't break re-parsing (zod strips
      // them from the IN-MEMORY Settings object, which is correct; they only need to survive on disk).
      expect(loadSettings(p).titles?.model).toBe(tag("codex-oauth/gpt-5.6-luna"));
    });

    test("survives a plugin.enable-shaped write (setPluginEnabled)", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-unknown-")), "settings.json");
      diskWithUnknownKeys(p);
      const before = loadSettings(p);
      const next = setPluginEnabled(before, "my-plugin", true);
      saveSettings(p, next);

      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.enabledPlugins).toEqual(["foo", "bar"]);
      expect(onDisk.reviewer.hooks).toEqual({ PreToolUse: [{ matcher: "Bash", hooks: [] }] });
      expect(onDisk.plugins.enabled).toEqual(["my-plugin"]); // the actual write landed
    });

    test("a torn on-disk file falls back to writing the caller's value verbatim (no crash, no merge attempted)", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-unknown-")), "settings.json");
      wf(p, "{not valid json"); // torn
      const s: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.6-sol") } };
      expect(() => saveSettings(p, s)).not.toThrow();
      expect(loadSettings(p)).toEqual(s); // healed: the file is valid again, with no unknown keys to recover
    });

    test("clearing a known field (setModelRole → null) removes it even though it survives on disk before the write", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-unknown-")), "settings.json");
      wf(p, JSON.stringify({
        schemaVersion: 3,
        provider: { model: "codex-oauth/gpt-5.6-sol" },
        enabledPlugins: ["foo"],
        titles: { enabled: true, model: "codex-oauth/gpt-5.6-luna" },
      }, null, 2));
      const before = loadSettings(p);
      const next = setModelRole(before, "titles.model", null); // clear the override
      saveSettings(p, next);

      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.enabledPlugins).toEqual(["foo"]); // unrelated unknown key untouched
      expect(onDisk.titles.enabled).toBe(true); // known sibling key untouched
      expect(onDisk.titles.model).toBeUndefined(); // the clear won — daemon-owned keys win
    });

    test("does not trigger extra writes (single writeFileSync call — no reload-storm risk)", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-unknown-")), "settings.json");
      diskWithUnknownKeys(p);
      const before = loadSettings(p);
      saveSettings(p, setModelRole(before, "titles.model", "codex-oauth/gpt-5.6-luna"));
      // A second identical save is idempotent — merging is deterministic, not additive/growing.
      const afterFirst = readFileSync(p, "utf8");
      saveSettings(p, loadSettings(p));
      const afterSecond = readFileSync(p, "utf8");
      expect(JSON.parse(afterSecond)).toEqual(JSON.parse(afterFirst));
    });

    // BLOCKER (fix wave, pre-merge review): a home still v2-shaped ON DISK (the v2→v3 migration is
    // in-memory only unless `persistMigration: true`, which only the daemon boot hook passes) used
    // to make EVERY settings write throw — `mergeUnknownKeys`'s object case copied the on-disk
    // `provider` block's stray `type`/`baseUrl` keys straight into the merged result, and the
    // `.strict()` schema then refused them at the second `Settings.parse`. Measured red before the
    // fix: `unrecognized_keys ["type"] at ["provider"]`.
    test("a v2-shaped `provider` block on disk survives a setModelRole write (BLOCKER)", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-v2-provider-")), "settings.json");
      wf(p, JSON.stringify({
        schemaVersion: 2,
        provider: { type: "codex-oauth", model: "codex-oauth/gpt-5.6-sol" },
      }, null, 2));
      const before = loadSettings(p); // migrates in memory only — the file on disk stays v2-shaped
      expect(() => saveSettings(p, setModelRole(before, "titles.model", "codex-oauth/gpt-5.6-luna"))).not.toThrow();

      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.schemaVersion).toBe(3);
      expect(onDisk.provider).toEqual({ model: "codex-oauth/gpt-5.6-sol" }); // `type` dropped, not carried through
      expect(onDisk.titles.model).toBe("codex-oauth/gpt-5.6-luna");
      expect(loadSettings(p).titles?.model).toBe(tag("codex-oauth/gpt-5.6-luna"));
    });

    // Same shape for `runtimes.official` — the OTHER `.strict()` block, guarding against a stray
    // legacy `auth` key surviving from a v2-or-earlier `runtimes.official.auth` write. Unlike the
    // `provider` block, this one is `.optional()` at the `runtimes.official` level, so the fixture
    // must keep `runtimes.official` PRESENT in the owned value too — otherwise the whole block is
    // simply absent-and-cleared (a different, already-correct code path) and the `.strict()` branch
    // is never reached at all.
    test("a stray legacy `runtimes.official.auth` key on disk survives a setSkillDenied write (BLOCKER)", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-v2-official-")), "settings.json");
      wf(p, JSON.stringify({
        schemaVersion: 3,
        provider: { model: "codex-oauth/gpt-5.6-sol" },
        runtimes: { official: { auth: "console", subscriptionAuth: false } },
      }, null, 2));
      // `loadSettings` on a schemaVersion-3 file does NOT run the v2→v3 migration — it straight-up
      // refuses a stray `auth` key inside the `.strict()` `runtimes.official` block, so this fixture
      // (which deliberately still has the stray key ON DISK) is built by hand rather than via
      // `loadSettings(p)`, exactly the "file drifted after `s` was last read" scenario the function's
      // own comment names.
      const before: Settings = {
        schemaVersion: 3,
        provider: { model: tag("codex-oauth/gpt-5.6-sol") },
        runtimes: { official: { subscriptionAuth: false } } as Settings["runtimes"],
      };
      expect(() => saveSettings(p, setSkillDenied(before, "bash-review", true))).not.toThrow();

      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.runtimes.official).toEqual({ subscriptionAuth: false }); // `auth` dropped, not carried through
      expect(onDisk.permissions.deny).toEqual([skillDenyRule("bash-review")]);
    });

    // Minor 5b (pre-merge review): corrects this file's own doc claim that "an unknown field nested
    // inside one server's config still survives" a save. `McpServerSettingsEntry` is a
    // `z.preprocess(...)` (a `"pipe"` def in zod v4) — `mergeUnknownKeys` does not special-case that
    // def type, so it hits the leaf branch and `owned` wins outright for the WHOLE entry. An unknown
    // field inside one server's config is dropped, and a legacy typeless stdio entry is normalized
    // (an explicit `type: "stdio"` written back) on any unrelated save that round-trips it.
    test("an unknown field nested inside one mcpServers entry does NOT survive a save (corrected doc, 5b)", () => {
      const p = join(mkdtempSync(join(tmpdir(), "winter-save-mcp-entry-")), "settings.json");
      wf(p, JSON.stringify({
        schemaVersion: 3,
        provider: { model: "codex-oauth/gpt-5.6-sol" },
        // a typeless legacy stdio entry, with a field this schema has never modeled at all.
        mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], future: "field" } },
      }, null, 2));
      const before = loadSettings(p); // `future` is stripped in-memory (zod default: strip unknown)
      saveSettings(p, setModelRole(before, "titles.model", "codex-oauth/gpt-5.6-luna"));

      const onDisk = JSON.parse(readFileSync(p, "utf8"));
      expect(onDisk.mcpServers.everything.future).toBeUndefined(); // NOT preserved (corrects the old doc claim)
      expect(onDisk.mcpServers.everything.type).toBe("stdio"); // normalized on write, even though this save never touched mcpServers
      expect(onDisk.mcpServers.everything.command).toBe("npx");
    });
  });
});

describe("setProviderModel / setReasoningEffort (winter model CLI's pure transforms)", () => {
  test("setProviderModel changes only provider.model, preserving every other field", () => {
    const s: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.6-sol"), reasoningEffort: "high" }, plugins: { enabled: ["a"] } };
    const next = setProviderModel(s, tag("codex-oauth/gpt-5.6-luna"));
    expect(next.provider).toEqual({ model: tag("codex-oauth/gpt-5.6-luna"), reasoningEffort: "high" });
    expect(next.plugins).toEqual({ enabled: ["a"] });
  });

  test("setProviderModel changes provider even across providers (openai)", () => {
    const s: Settings = { schemaVersion: 3, provider: { model: tag("openai/gpt-5.2") }, providers: { openai: { baseUrl: "https://x" } } };
    const next = setProviderModel(s, tag("openai/gpt-5.9"));
    expect(next.provider).toEqual({ model: tag("openai/gpt-5.9") });
    expect(next.providers).toEqual({ openai: { baseUrl: "https://x" } }); // untouched — a sibling block
  });

  test("setReasoningEffort sets/clears provider.reasoningEffort, preserving model", () => {
    const s: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.6-sol") } };
    const withEffort = setReasoningEffort(s, "xhigh");
    expect(withEffort.provider).toEqual({ model: tag("codex-oauth/gpt-5.6-sol"), reasoningEffort: "xhigh" });
    const cleared = setReasoningEffort(withEffort, undefined);
    expect(cleared.provider.model).toBe(tag("codex-oauth/gpt-5.6-sol"));
    expect(cleared.provider.reasoningEffort).toBeUndefined();
  });

  test("both transforms produce Settings.parse-valid output", () => {
    const s: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.6-sol") } };
    expect(() => Settings.parse(setReasoningEffort(setProviderModel(s, tag("codex-oauth/gpt-5.6-terra")), "max"))).not.toThrow();
  });

  // WS-20 (review round 4): `setProviderModel` is UNCONSTRAINED again — a round-2 gate to
  // `INTERNAL_PROVIDER_IDS` lived here briefly and broke a real "my default chat model is Claude"
  // scenario (a SESSION's own default falls back to THIS field too, not just the daemon's internal
  // Provider — session-driver.ts's create()). The constraint now lives only where the internal
  // Provider is actually built (`createProvider`, which answers `null` rather than a refusal).
  test("R4: setProviderModel accepts any catalog provider, including one the internal Provider cannot serve", () => {
    const s: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.6-sol") } };
    const next = setProviderModel(s, tag("anthropic/claude-sonnet-5"));
    expect(next.provider.model).toBe(tag("anthropic/claude-sonnet-5"));
    expect(() => Settings.parse(next)).not.toThrow();
  });
});

// USER RULING 2026-09-18: a role write must name a model the pinned catalog actually backs. Before
// this, only the tag's SHAPE was checked, so an unbacked tag was written to settings.json and failed
// later at the spawn that tried to use it — with the Roles-pane picker as the only real gate.
describe("setModelRole: the catalog-membership check", () => {
  const base: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.6-sol") } };

  test("a shape-valid tag no catalog row backs is REFUSED, for every role that takes one", () => {
    for (const role of ["pins.dispatch", "titles.model", "reviewer.model", "provider.model", "runtimes.advisorModel"] as const) {
      expect(() => setModelRole(base, role, "openai/model-that-does-not-exist")).toThrow(/no model in the pinned catalog/);
    }
  });

  test("a real catalog tag is accepted", () => {
    expect(setModelRole(base, "pins.dispatch", "anthropic/claude-sonnet-5").pins?.dispatch).toBe(tag("anthropic/claude-sonnet-5"));
    expect(setModelRole(base, "provider.model", "anthropic/claude-sonnet-5").provider.model).toBe(tag("anthropic/claude-sonnet-5"));
  });

  // Not leniency: `winter-test/*` is not a catalog provider at all (provider-selection.ts's
  // WINTER_TEST_MODEL_PREFIX — "must never be resolved against one"), and setProviderModel has always
  // taken it. A catalog lookup would refuse every test harness that names its own fake model.
  test("winter-test/* is exempt, because it is not a catalog namespace", () => {
    expect(setModelRole(base, "pins.dispatch", "winter-test/echo").pins?.dispatch).toBe(tag("winter-test/echo"));
    expect(setModelRole(base, "provider.model", "winter-test/echo").provider.model).toBe(tag("winter-test/echo"));
  });

  // The check must never stand between a user and a role's default.
  test("clearing a role is never catalog-checked", () => {
    const withPin = setModelRole(base, "pins.dispatch", "anthropic/claude-sonnet-5");
    expect(setModelRole(withPin, "pins.dispatch", null).pins?.dispatch).toBeUndefined();
    expect(setModelRole(withPin, "runtimes.advisorModel", null).runtimes?.advisorModel).toBeUndefined();
  });

  // The membership test is the CATALOG, deliberately not the role's own `permitted` set: an
  // "internal-provider" role narrows `permitted` to the CURRENTLY BOUND provider, so gating the write
  // on it would refuse pinning a role to a provider the user is about to bind. Existence and
  // present-tense usability are different questions, and clients already receive `constraint`.
  test("a catalog tag an internal-provider role cannot serve TODAY is still accepted", () => {
    const info = modelRoleInfo(base, "titles.model", "openai");
    expect(info.constraint).toBe("internal-provider");
    const unservable = "anthropic/claude-sonnet-5";
    expect(info.permitted.some((p) => p.models.includes(tag(unservable)))).toBe(false);
    expect(setModelRole(base, "titles.model", unservable).titles?.model).toBe(tag(unservable));
  });
});

// -------------------------------------------------------------------------------------------------
// 2026-09-18, item 3: a role's reasoning effort — the pure transforms and readers under
// `settings.setModelRole`'s `effort` field. The RPC-level behaviour is
// `test/ipc/settings-model-roles.test.ts`.
// -------------------------------------------------------------------------------------------------
describe("role reasoning efforts (roleEfforts / roleEffortFor / roleAcceptsClientEffort)", () => {
  const base: Settings = { schemaVersion: 3, provider: { model: tag("codex-oauth/gpt-5.6-sol") } };

  // The same literal-parity tripwire `MODEL_ROLES / protocol ModelRole parity` applies to the storage
  // block: its keys are a THIRD hand-spelled copy of the role list (after `MODEL_ROLES` and the
  // protocol enum), and they must stay exactly "every role except `provider.model`" — that exception
  // is the whole reason the block's keys are not simply `MODEL_ROLES`.
  test("the roleEfforts schema's keys are exactly MODEL_ROLES minus provider.model", () => {
    const shape = (Settings.shape.roleEfforts as unknown as { unwrap(): { shape: Record<string, unknown> } }).unwrap().shape;
    expect(Object.keys(shape).sort()).toEqual(MODEL_ROLES.filter((r) => r !== "provider.model").slice().sort());
  });

  test("roleEffortFor: absent everywhere means absent — no level is ever invented", () => {
    for (const role of MODEL_ROLES) expect(roleEffortFor(base, role)).toBeUndefined();
    expect(roleEffortFor(null, "pins.dispatch")).toBeUndefined();
    expect(roleEffortFor(undefined, "provider.model")).toBeUndefined();
  });

  test("the block is keyed by the role id VERBATIM — the wire's `role` parameter is the settings key", () => {
    const set = setModelRole(base, "pins.dispatch", "codex-oauth/gpt-5.6-terra", "high");
    expect(set.roleEfforts).toEqual({ "pins.dispatch": "high" });
    expect(roleEffortFor(set, "pins.dispatch")).toBe("high");
    // Every role except `provider.model` is a key of this block, and each is independent.
    const many = MODEL_ROLES.filter((r) => r !== "provider.model")
      .reduce<Settings>((s, role) => setModelRole(s, role, "codex-oauth/gpt-5.6-terra", "low"), base);
    expect(Object.keys(many.roleEfforts ?? {}).sort()).toEqual(MODEL_ROLES.filter((r) => r !== "provider.model").slice().sort());
  });

  test("provider.model reads and writes `provider.reasoningEffort`, never the new block", () => {
    const set = setModelRole(base, "provider.model", "codex-oauth/gpt-5.6-sol", "max");
    expect(set.provider.reasoningEffort).toBe("max");
    expect(set.roleEfforts).toBeUndefined();
    expect(roleEffortFor(set, "provider.model")).toBe("max");
    // And an effort written the OLD way (`winter model --effort`) reads back through the role door.
    const legacy = setReasoningEffort(base, "low");
    expect(roleEffortFor(legacy, "provider.model")).toBe("low");
    expect(modelRoleInfo(legacy, "provider.model")).toMatchObject({ effort: "low", effortExplicit: true });
    // Clearing goes back through the same door.
    expect(setModelRole(set, "provider.model", "codex-oauth/gpt-5.6-sol", null).provider.reasoningEffort).toBeUndefined();
  });

  test("absent `effort` leaves a stored one untouched; `null` clears it — the two are distinguishable", () => {
    const withEffort = setModelRole(base, "pins.dream", "codex-oauth/gpt-5.6-luna", "high");
    // A model-only write (the 3-argument call every pre-existing caller makes) changes nothing here.
    const modelOnly = setModelRole(withEffort, "pins.dream", "codex-oauth/gpt-5.6-terra");
    expect(modelOnly.pins?.dream).toBe(tag("codex-oauth/gpt-5.6-terra"));
    expect(roleEffortFor(modelOnly, "pins.dream")).toBe("high");
    expect(roleEffortFor(setModelRole(withEffort, "pins.dream", "codex-oauth/gpt-5.6-luna", null), "pins.dream")).toBeUndefined();
  });

  test("modelRoleInfo: efforts carries the CURRENT model's vocabulary, with null and [] kept apart", () => {
    // A row with a vocabulary, in the catalog's own order and with no "none" prepended.
    expect(modelRoleInfo(base, "provider.model").efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // A row with NO `reasoning` block at all.
    const noBlock = setModelRole(base, "provider.model", "openai/gpt-5.4");
    expect(modelRoleInfo(noBlock, "provider.model").efforts).toBeNull();
    // A row WITH a `reasoning` block whose vocabulary is empty — a different fact, a different answer.
    const emptyVocab = setModelRole(base, "pins.dispatch", "agnes/agnes-2.0-flash");
    expect(modelRoleInfo(emptyVocab, "pins.dispatch").efforts).toEqual([]);
    // A role naming no model at all has nothing to ask.
    expect(modelRoleInfo(base, "runtimes.advisorModel")).toMatchObject({ model: null, efforts: null });
  });

  test("an effort outside the model's vocabulary is refused; \"none\" is accepted on any row that has one", () => {
    // `openai/o4-mini` declares exactly ["low","medium","high"] — `"max"` is a perfectly real wire
    // effort that THIS model does not offer, which is the case a per-model check exists for (a row
    // offering all five, like the gpt-5.6 family, could never exercise it).
    expect(modelRoleInfo(setModelRole(base, "pins.dispatch", "openai/o4-mini"), "pins.dispatch").efforts)
      .toEqual(["low", "medium", "high"]);
    expect(() => setModelRole(base, "pins.dispatch", "openai/o4-mini", "max"))
      .toThrow(/effort 'max' is not accepted by model 'openai\/o4-mini' — supported: none, low, medium, high/);
    expect(roleEffortFor(setModelRole(base, "pins.dispatch", "openai/o4-mini", "high"), "pins.dispatch")).toBe("high");
    // `"none"` is never in a catalog vocabulary (it is Winter's own unset) but is always accepted on a
    // row that HAS one — the `effortsForModel` rule, restated by this door.
    expect(roleEffortFor(setModelRole(base, "pins.dispatch", "codex-oauth/gpt-5.6-terra", "none"), "pins.dispatch")).toBe("none");
  });

  test("the vocabulary is the row's OWN order, never sorted or normalised by this daemon", () => {
    // `xai-oauth/grok-4.5` declares ["high","medium","low"] — strongest-first, the reverse of every
    // other row's order. A consumer rendering a slider needs the catalog's order, not an opinion.
    expect(modelRoleInfo(setModelRole(base, "pins.dispatch", "xai-oauth/grok-4.5"), "pins.dispatch").efforts)
      .toEqual(["high", "medium", "low"]);
  });

  test("ANY effort is refused on a real catalog row that declares no vocabulary — both shapes of it", () => {
    for (const model of ["openai/gpt-5.4", "agnes/agnes-2.0-flash"]) {
      for (const effort of ["high", "none"]) {
        expect(() => setModelRole(base, "pins.dispatch", model, effort)).toThrow(/declares no reasoning-effort vocabulary/);
      }
    }
  });

  test("a tag with no catalog row at all passes through unchecked — implicitEffortFor's own posture", () => {
    // `winter-test/*` is not a catalog namespace (the harness doubles accept anything), so there is no
    // evidence to refuse on. Same for any future BYO-endpoint id.
    expect(roleEffortFor(setModelRole(base, "pins.dispatch", "winter-test/echo", "high"), "pins.dispatch")).toBe("high");
  });

  test("a Winter-level tier is refused on every role, and no role accepts one today", () => {
    for (const role of MODEL_ROLES) expect(roleAcceptsClientEffort(role)).toBe(false);
    for (const tier of CLIENT_EFFORTS) {
      expect(() => setModelRole(base, "pins.dispatch", "codex-oauth/gpt-5.6-terra", tier)).toThrow(/Winter-level tier/);
      expect(() => setModelRole(base, "provider.model", "codex-oauth/gpt-5.6-sol", tier)).toThrow(/Winter-level tier/);
    }
    // The dispatch arm is asked through `clientEffortEligible` rather than hardcoded, so the role
    // answer and the session answer move together.
    expect(clientEffortEligible("dispatch")).toBe(false);
  });

  test("a level the catalog could name but this daemon cannot STORE is refused at the door, not inside saveSettings", () => {
    // `roleEfforts` is `z.enum(REASONING_EFFORTS)` (like its `provider.reasoningEffort` sibling), so a
    // value outside that enum could never be persisted. Refusing it here keeps it an INVALID_PARAMS
    // rather than a throw out of `saveSettings`'s own validation pass.
    expect(REASONING_EFFORTS).not.toContain("minimal" as never);
    expect(() => setModelRole(base, "pins.dispatch", "codex-oauth/gpt-5.6-terra", "MEDIUM"))
      .toThrow(/is not a reasoning effort this daemon can store/);
  });

  test("a stored roleEfforts block survives an unrelated save (load → transform → save round trip)", () => {
    const path = tmpSettings({
      schemaVersion: 3,
      provider: { model: "codex-oauth/gpt-5.6-sol" },
      roleEfforts: { "pins.dream": "high", "titles.model": "low" },
      someFutureKey: { kept: true },
    });
    // A write from a surface that knows nothing about efforts.
    saveSettings(path, setSkillDenied(loadSettings(path), "some-skill", true));
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.roleEfforts).toEqual({ "pins.dream": "high", "titles.model": "low" });
    expect(after.someFutureKey).toEqual({ kept: true });
    // …and an entry this schema does not model inside the block rides through too (the block is not
    // `.strict()`, so `mergeUnknownKeys`' general rule applies to it).
    const path2 = tmpSettings({
      schemaVersion: 3,
      provider: { model: "codex-oauth/gpt-5.6-sol" },
      roleEfforts: { "pins.dream": "high", "roles.notYetInvented": "high" },
    });
    saveSettings(path2, setSkillDenied(loadSettings(path2), "some-skill", true));
    expect(JSON.parse(readFileSync(path2, "utf8")).roleEfforts).toEqual({ "pins.dream": "high", "roles.notYetInvented": "high" });
  });
});

describe("setOutputStyle (CC-parity output styles: the active style name)", () => {
  test("setOutputStyle sets and clears the key, preserving other fields", () => {
    const base = { schemaVersion: 3, provider: { model: "codex-oauth/x" } } as any;
    const set = setOutputStyle(base, "proactive");
    expect(set.outputStyle).toBe("proactive");
    expect(set.provider).toEqual(base.provider); // untouched
    expect(setOutputStyle(set, undefined).outputStyle).toBeUndefined(); // cleared
    expect(setOutputStyle(set, "default").outputStyle).toBeUndefined();  // "default" clears it
  });

  test("Settings accepts an outputStyle string", () => {
    const { Settings } = require("../src/settings");
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/x" }, outputStyle: "learning" }).outputStyle).toBe("learning");
  });
});

describe("permission directories", () => {
  test("Settings accepts an optional permissions.additionalDirectories block", () => {
    const p = tmpSettings({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, permissions: { additionalDirectories: ["~/x"] } });
    expect(loadSettings(p).permissions?.additionalDirectories).toEqual(["~/x"]);
  });

  test("loadPermissionDirs merges user + project + local, expands ~, dedups (trusted project)", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-perm-home-"));
    const project = mkdtempSync(join(tmpdir(), "winter-perm-proj-"));
    wf(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, permissions: { additionalDirectories: ["~/shared"] } }));
    mkdirSync(join(project, ".winter"), { recursive: true });
    wf(join(project, ".winter", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/data", "~/shared"] } }));
    wf(join(project, ".winter", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/tmp/local-grant"] } }));
    // committed .winter/settings.json only merges when the project is trusted — see
    // "loadPermissionDirs trust gating" below for the untrusted-gates-it-out coverage.
    const dirs = loadPermissionDirs(home, project, true);
    const { homedir } = require("node:os");
    expect(dirs).toContain(join(homedir(), "shared"));
    expect(dirs).toContain("/opt/data");
    expect(dirs).toContain("/tmp/local-grant");
    expect(dirs.filter((d) => d === join(homedir(), "shared"))).toHaveLength(1); // deduped
  });

  test("loadPermissionDirs tolerates missing files and missing blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-perm-h2-"));
    expect(loadPermissionDirs(home)).toEqual([]); // nothing configured
  });

  test("addLocalDir appends to settings.local.json without duplicates", () => {
    const project = mkdtempSync(join(tmpdir(), "winter-perm-add-"));
    addLocalDir(project, "/opt/one");
    addLocalDir(project, "/opt/one"); // dup ignored
    addLocalDir(project, "/opt/two");
    const local = JSON.parse(require("node:fs").readFileSync(join(project, ".winter", "settings.local.json"), "utf8"));
    expect(local.permissions.additionalDirectories).toEqual(["/opt/one", "/opt/two"]);
  });
});

describe("loadPermissionDirs trust gating", () => {
  function scaffold() {
    const home = mkdtempSync(join(tmpdir(), "winter-tg-home-"));
    const project = mkdtempSync(join(tmpdir(), "winter-tg-proj-"));
    mkdirSync(join(project, ".winter"), { recursive: true });
    wf(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" }, permissions: { additionalDirectories: ["/opt/user-dir"] } }));
    wf(join(project, ".winter", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/committed-dir"] } }));       // committed → trust-gated
    wf(join(project, ".winter", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/opt/local-dir"] } }));    // fix-wave A2: local is ALSO trust-gated now (a repo can force-commit one)
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
    const home = mkdtempSync(join(tmpdir(), "winter-tg-h2-"));
    const project = mkdtempSync(join(tmpdir(), "winter-tg-p2-"));
    mkdirSync(join(project, ".winter"), { recursive: true });
    wf(join(project, ".winter", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: ["/", "~"] } }));
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

// P8a Task 11 (WS-16 §16): the runtime-state retention + migration block. Hot like every other
// settings key — a sweep reads it through a getter each pass, so changing a window never needs a
// daemon restart.
describe("settings.runtimes", () => {
  const base = { schemaVersion: 3 as const, provider: { model: DEFAULT_PROVIDER.model } };

  // The block is OPTIONAL, like every other top-level key here — a defaulted one would make
  // `runtimes` required on the inferred Settings type and would make `saveSettings` stamp today's
  // defaults into every user's file. The shipped 30/7 answer for an absent block lives in
  // `retentionFromSettings`, the door every consumer reads (see runtime-state/retention.test.ts).
  test("an absent block stays absent rather than freezing today's defaults into the file", () => {
    expect(Settings.parse(base).runtimes).toBeUndefined();
  });

  test("an empty block fills every nested default rather than staying empty", () => {
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes).toEqual({
      retention: { deliveriesDays: 30, nameLeasesDays: 7 },
      migrations: { memoryKeys: false },
      // P8b Task 15: the Winter-leg keys default to "behave exactly as this daemon does today" —
      // and Task 17 Step 1 flipped dispatch once its e2e proof landed.
      winterLeg: { chat: true, dispatch: true, code: true },
      winterIdleTimeoutSec: 900,
      // Fix wave (C2 / P8c-18); Winter Phase 10b (D1-1): `crossRuntime` stays UNSET rather than
      // filled with a schema default — the mode-aware default (ON for Code, OFF for chat/dispatch)
      // lives in `handoffCrossRuntimeEnabled`'s own tests below, not in the raw parse.
      handoff: {},
    });
    // The two optional strings stay ABSENT rather than becoming "": a present-but-empty value would
    // be a path/model the consumers have to special-case forever.
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes).not.toHaveProperty("winterExecutable");
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes).not.toHaveProperty("advisorModel");
  });

  test("a half-specified retention block keeps the other default", () => {
    expect(Settings.parse({ ...base, runtimes: { retention: { deliveriesDays: 90 } } }).runtimes?.retention)
      .toEqual({ deliveriesDays: 90, nameLeasesDays: 7 });
  });

  test("the memory-key migration is OFF until a user turns it on — it relocates a user's own files", () => {
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes?.migrations.memoryKeys).toBe(false);
    expect(Settings.parse({ ...base, runtimes: { migrations: { memoryKeys: true } } }).runtimes?.migrations.memoryKeys).toBe(true);
  });

  test("a zero-day retention window is rejected — it would prune evidence the same second it lands", () => {
    expect(() => Settings.parse({ ...base, runtimes: { retention: { deliveriesDays: 0 } } })).toThrow();
    expect(() => Settings.parse({ ...base, runtimes: { retention: { nameLeasesDays: 0 } } })).toThrow();
    expect(() => Settings.parse({ ...base, runtimes: { retention: { deliveriesDays: 1.5 } } })).toThrow();
    expect(() => Settings.parse({ ...base, runtimes: { retention: { deliveriesDays: -30 } } })).toThrow();
  });

  // ── P8b Task 15: the Winter-leg keys ───────────────────────────────────────────────────────────
  // Every one of them defaults to today's behaviour, because a daemon that has never been configured
  // must not change what it does when this build lands.

  test("every leg defaults ON (Task 17: the engine is retired); a written false PARSES (accepted for one release) but the door ignores it", () => {
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes?.winterLeg).toEqual({ chat: true, dispatch: true, code: true });
    expect(Settings.parse({ ...base, runtimes: { winterLeg: { dispatch: false } } }).runtimes?.winterLeg)
      .toEqual({ chat: true, dispatch: false, code: true });
    expect(winterOptionsFromSettings(Settings.parse({ ...base, runtimes: { winterLeg: { dispatch: false } } })).winterLeg)
      .toEqual({ chat: true, dispatch: true, code: true });
  });

  test("winterExecutable and advisorModel are absent by default and accept a plain string", () => {
    const none = Settings.parse({ ...base, runtimes: {} }).runtimes;
    expect(none?.winterExecutable).toBeUndefined();
    expect(none?.advisorModel).toBeUndefined();
    const set = Settings.parse({ ...base, runtimes: { winterExecutable: "/opt/winter/bin/winter", advisorModel: "some-model" } }).runtimes;
    expect(set?.winterExecutable).toBe("/opt/winter/bin/winter");
    expect(set?.advisorModel).toBe("some-model");
  });

  test("an EMPTY winterExecutable parses rather than bricking the file — loadSettings throws on invalid, and the daemon would not start", () => {
    // Deliberately NOT `.min(1)`. A user clearing the field to "" must be a no-op the consumer
    // treats as absent (memory-dir.ts's trim-is-absent convention), never a daemon that refuses to
    // boot over one blank string.
    expect(Settings.parse({ ...base, runtimes: { winterExecutable: "" } }).runtimes?.winterExecutable).toBe("");
    expect(Settings.parse({ ...base, runtimes: { advisorModel: "" } }).runtimes?.advisorModel).toBe("");
  });

  test("winterIdleTimeoutSec defaults to 900s and refuses a value too small to survive a pause in typing", () => {
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes?.winterIdleTimeoutSec).toBe(900);
    expect(Settings.parse({ ...base, runtimes: { winterIdleTimeoutSec: 30 } }).runtimes?.winterIdleTimeoutSec).toBe(30);
    expect(() => Settings.parse({ ...base, runtimes: { winterIdleTimeoutSec: 9 } })).toThrow();
    expect(() => Settings.parse({ ...base, runtimes: { winterIdleTimeoutSec: 900.5 } })).toThrow();
  });

  test("an unknown key under runtimes is STRIPPED, not rejected — the same thing the surrounding schema does", () => {
    // Asserting today's behaviour rather than choosing one: zod v4's `z.object()` strips unknown
    // keys, which is what lets a user's file survive a downgrade and what `loadSettings`'s own v1
    // migration comment already relies on. A future `.strict()` here would turn every settings.json
    // written by a NEWER Winter into a boot failure on an older one.
    const parsed = Settings.parse({ ...base, runtimes: { winterLegg: { chat: true }, nonsense: 1 } });
    expect(parsed.runtimes).not.toHaveProperty("winterLegg");
    expect(parsed.runtimes).not.toHaveProperty("nonsense");
    expect(parsed.runtimes?.winterLeg).toEqual({ chat: true, dispatch: true, code: true });
    // And the same one level up, so this is the schema's convention rather than a local accident.
    expect(Settings.parse({ ...base, nonsenseTopLevel: 1 } as never)).not.toHaveProperty("nonsenseTopLevel");
  });

  test("a wrongly-typed leg is rejected — a string 'true' must never read as a leg that is on", () => {
    expect(() => Settings.parse({ ...base, runtimes: { winterLeg: { chat: "true" } } })).toThrow();
  });

  // Fix wave (whole-branch review C2 / ruling P8c-18); Winter Phase 10b (D1-1): `crossRuntime`
  // stays UNSET by default — no schema-level default at all — so the raw parse can never be
  // confused with an explicit choice. The mode-aware default lives entirely in
  // `handoffCrossRuntimeEnabled`, exercised below.
  test("crossRuntime stays unset by default and accepts an explicit true/false", () => {
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes?.handoff).toEqual({});
    expect(Settings.parse({ ...base, runtimes: { handoff: { crossRuntime: true } } }).runtimes?.handoff)
      .toEqual({ crossRuntime: true });
    expect(Settings.parse({ ...base, runtimes: { handoff: { crossRuntime: false } } }).runtimes?.handoff)
      .toEqual({ crossRuntime: false });
  });
});

// Winter Phase 10b (D1-1, W18-10, R-10b-1): `runtimes.handoff.crossRuntime` now defaults ON for
// Code sessions (the real round-trip against the live barrier is measured end to end) and stays
// OFF for chat/dispatch, which never reach the official leg regardless
// (`select-runtime.ts`'s own mode gate). An explicit setting always overrides the mode-aware
// default, in every mode.
describe("handoffCrossRuntimeEnabled", () => {
  const base = { schemaVersion: 3 as const, provider: { model: DEFAULT_PROVIDER.model } };

  test("null/undefined settings (a boot-degraded daemon) fall back to the mode-aware default, never a throw", () => {
    expect(handoffCrossRuntimeEnabled(null)).toBe(true); // omitted mode reads as Code
    expect(handoffCrossRuntimeEnabled(undefined)).toBe(true);
    expect(handoffCrossRuntimeEnabled(null, "code")).toBe(true);
    expect(handoffCrossRuntimeEnabled(null, "chat")).toBe(false);
    expect(handoffCrossRuntimeEnabled(null, "dispatch")).toBe(false);
  });

  test("an absent runtimes block answers the mode-aware default: ON for Code, OFF for chat/dispatch", () => {
    expect(handoffCrossRuntimeEnabled(Settings.parse(base))).toBe(true);
    expect(handoffCrossRuntimeEnabled(Settings.parse(base), "code")).toBe(true);
    expect(handoffCrossRuntimeEnabled(Settings.parse(base), "chat")).toBe(false);
    expect(handoffCrossRuntimeEnabled(Settings.parse(base), "dispatch")).toBe(false);
  });

  test("an empty runtimes block answers the same mode-aware default — crossRuntime stays unset, not schema-defaulted", () => {
    expect(handoffCrossRuntimeEnabled(Settings.parse({ ...base, runtimes: {} }))).toBe(true);
    expect(handoffCrossRuntimeEnabled(Settings.parse({ ...base, runtimes: {} }), "dispatch")).toBe(false);
  });

  test("an explicit value overrides the mode-aware default, in every mode", () => {
    expect(handoffCrossRuntimeEnabled(Settings.parse({ ...base, runtimes: { handoff: { crossRuntime: true } } }), "chat")).toBe(true);
    expect(handoffCrossRuntimeEnabled(Settings.parse({ ...base, runtimes: { handoff: { crossRuntime: true } } }), "dispatch")).toBe(true);
    expect(handoffCrossRuntimeEnabled(Settings.parse({ ...base, runtimes: { handoff: { crossRuntime: false } } }))).toBe(false);
    expect(handoffCrossRuntimeEnabled(Settings.parse({ ...base, runtimes: { handoff: { crossRuntime: false } } }), "code")).toBe(false);
  });

  test("a hot-reload flip takes effect immediately through the same getter — no restart, no cached decision", () => {
    let live: Settings = Settings.parse(base);
    const read = () => live;
    expect(handoffCrossRuntimeEnabled(read(), "code")).toBe(true); // Code default ON, nothing set yet
    live = Settings.parse({ ...base, runtimes: { handoff: { crossRuntime: false } } });
    expect(handoffCrossRuntimeEnabled(read(), "code")).toBe(false); // same getter, flipped off, no restart
  });
});

// WS-20: `runtimes.official.auth` (and its reader `officialAuthModeSetting`) is REMOVED, not
// deprecated — the official leg's auth arm is now the tag's own prefix
// (`officialAuthArmFor(selection)`, official-options.ts). `subscriptionAuth` stays, orthogonal to
// which arm.
describe("runtimes.official schema (WS-20: auth is gone)", () => {
  const base = { schemaVersion: 3 as const, provider: { model: DEFAULT_PROVIDER.model } };

  test("runtimes.official.auth is gone", () => {
    expect(() => Settings.parse({ ...base, runtimes: { official: { auth: "console" } } })).toThrow();
  });

  test("subscriptionAuth still parses, default false", () => {
    expect(Settings.parse({ ...base, runtimes: { official: {} } }).runtimes?.official?.subscriptionAuth).toBe(false);
    expect(Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: true } } }).runtimes?.official?.subscriptionAuth).toBe(true);
  });

  test("antExecutable parses as an optional string beside winterExecutable/claudeExecutable", () => {
    expect(Settings.parse({ ...base, runtimes: { antExecutable: "/opt/ant/ant" } }).runtimes?.antExecutable).toBe("/opt/ant/ant");
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes?.antExecutable).toBeUndefined();
  });
});

// WS-20 (plan Task L3.2, Step 1's exact test list).
describe("WS-20: provider.model is a tag", () => {
  test("provider.model is a tag; a bare id is rejected; `type` is gone (strict object)", () => {
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra" } }).provider.model).toBe(tag("codex-oauth/gpt-5.6-terra"));
    expect(() => Settings.parse({ schemaVersion: 3, provider: { model: "gpt-5.6-terra" } })).toThrow();
    expect(() => Settings.parse({ schemaVersion: 3, provider: { type: "codex-oauth", model: "codex-oauth/gpt-5.6-terra" } })).toThrow(); // `type` is gone (strict object)
  });

  // WS-20 (review round 4): `provider.model` accepts ANY catalog provider's tag, or `winter-test/*`
  // — the SAME `ModelTagSchemaCore` every other model-bearing field uses. A round-2 gate
  // (`ProviderModelTagSchema`, narrowed to `INTERNAL_PROVIDER_IDS`) lived here briefly and broke a
  // real "my default chat model is Claude" scenario (a session with no explicit override falls
  // back to THIS field too — session-driver.ts's `create()`, not just the daemon's internal
  // Provider). The codex-oauth/openai constraint now lives only where the internal Provider is
  // actually built (`createProvider`, providers/manager.ts), which answers `null` rather than
  // refusing the write.
  test("R4: Settings.parse accepts provider.model naming ANY catalog provider, including one the internal Provider cannot serve", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "anthropic/claude-sonnet-5" } });
    expect(s.provider.model).toBe(tag("anthropic/claude-sonnet-5"));
    expect(Settings.parse({ schemaVersion: 3, provider: { model: "winter-test/echo" } }).provider.model).toBe(tag("winter-test/echo"));
  });
});

describe("WS-20: pinsFor", () => {
  test("pins default from the provider tag's provider, per slot", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } });
    expect(pinsFor(s)).toEqual({ dispatch: tag("codex-oauth/gpt-5.6-terra"), dream: tag("codex-oauth/gpt-5.6-terra"), cleaner: tag("codex-oauth/gpt-5.6-terra"), research: tag("codex-oauth/gpt-5.6-luna"), researchFallback: tag("codex-oauth/gpt-5.6-terra") });
    const o = Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" }, pins: { research: "openai/gpt-5.6-luna" } });
    expect(pinsFor(o).dispatch).toBe(tag("openai/gpt-5.6-terra"));
    expect(pinsFor(o).research).toBe(tag("openai/gpt-5.6-luna")); // explicit override wins
  });

  // WS-20 (review round 2, M6): the OLD `?? facingNameToTag("openai", slot)` fallback rung is gone
  // — a provider that serves no gpt-family row of its own now yields UNSTATED_TAG, never a silent
  // cross-provider guess. `provider.model` itself can no longer legitimately hold a non-internal
  // provider tag (the ProviderSettings schema refinement enforces codex-oauth/openai only), so this
  // fixture is hand-built (`as unknown as Settings`) rather than parsed — `pinsFor` is a pure
  // function over the object shape, not the schema.
  test("M6 (amended 2026-09-17): a provider serving no gpt-family row pins fall back to the user's OWN tag, never a cross-provider guess and never the sentinel", () => {
    const s = Settings.parse({ schemaVersion: 3, provider: { model: "anthropic/claude-sonnet-5" } });
    const p = pinsFor(s);
    expect(p.dispatch).toBe(tag("anthropic/claude-sonnet-5"));
    expect(p.dream).toBe(tag("anthropic/claude-sonnet-5"));
    expect(p.cleaner).toBe(tag("anthropic/claude-sonnet-5"));
    expect(p.research).toBe(tag("anthropic/claude-sonnet-5"));
    expect(p.researchFallback).toBe(tag("anthropic/claude-sonnet-5"));
    const d = Settings.parse({ schemaVersion: 3, provider: { model: "deepseek/deepseek-v4-flash" }, pins: { research: "deepseek/deepseek-reasoner" } });
    expect(pinsFor(d).dispatch).toBe(tag("deepseek/deepseek-v4-flash"));
    expect(pinsFor(d).research).toBe(tag("deepseek/deepseek-reasoner")); // explicit override still wins
    expect(Object.values(pinsFor(d))).not.toContain(UNSTATED_TAG);
  });

  // WS-20 (review round 2, M6 fix — R2): a `winter-test/*` primary (provider-less; the string
  // "winter-test" is never a pinned catalog provider) used to fall to UNSTATED_TAG the same way a
  // real non-serving provider does — but there is no OTHER model for the double to default to, so
  // every winter-test-primary daemon's dispatch/dream/cleaner/research refused outright. The
  // primary tag IS the pin instead: every slot defaults to the SAME double the session runs on.
  test("R2: a winter-test/* primary makes every pin default to the primary tag itself, never UNSTATED", () => {
    const s = { schemaVersion: 3, provider: { model: "winter-test/echo" } } as unknown as Settings;
    const p = pinsFor(s);
    expect(p.dispatch).toBe(tag("winter-test/echo"));
    expect(p.dream).toBe(tag("winter-test/echo"));
    expect(p.cleaner).toBe(tag("winter-test/echo"));
    expect(p.research).toBe(tag("winter-test/echo"));
    expect(p.researchFallback).toBe(tag("winter-test/echo"));
  });

  test("R2: an explicit settings.pins.* override still wins over the winter-test/* primary default", () => {
    const s = {
      schemaVersion: 3,
      provider: { model: "winter-test/echo" },
      pins: { dispatch: "winter-test/other-double" },
    } as unknown as Settings;
    const p = pinsFor(s);
    expect(p.dispatch).toBe(tag("winter-test/other-double")); // explicit wins
    expect(p.dream).toBe(tag("winter-test/echo")); // unoverridden slots still default to the primary
  });
});

// P8b Task 15 / review r1 F4: ONE door answers for an absent block and a blank string, so three
// lanes (Task 2's executable resolver, Task 5's create.ts, Task 9's leg + Task 16's idle timer)
// cannot each re-derive the conventions and cannot silently forget one.
describe("winterOptionsFromSettings", () => {
  const base = { schemaVersion: 3 as const, provider: { model: DEFAULT_PROVIDER.model } };

  test("an absent runtimes block answers with today's behaviour, not with undefined", () => {
    expect(winterOptionsFromSettings(Settings.parse(base))).toEqual({
      idleTimeoutSec: 900,
      winterLeg: { chat: true, dispatch: true, code: true },
    });
  });

  test("null/undefined settings answer the same way — the daemon boots with `settings = null` when the file is unusable", () => {
    expect(winterOptionsFromSettings(null)).toEqual(winterOptionsFromSettings(undefined));
    expect(winterOptionsFromSettings(null).winterLeg).toEqual({ chat: true, dispatch: true, code: true });
    expect(winterOptionsFromSettings(null).idleTimeoutSec).toBe(900);
  });

  test("a blank or whitespace-only executable/model is ABSENT, never the empty string", () => {
    const blank = winterOptionsFromSettings(Settings.parse({ ...base, runtimes: { winterExecutable: "   ", advisorModel: "" } }));
    expect(blank.winterExecutable).toBeUndefined();
    expect(blank.advisorModel).toBeUndefined();
    expect(blank).not.toHaveProperty("winterExecutable");
  });

  test("real values come through trimmed", () => {
    const set = winterOptionsFromSettings(Settings.parse({ ...base, runtimes: { winterExecutable: " /opt/winter/bin/winter ", advisorModel: "some-model", winterIdleTimeoutSec: 60, winterLeg: { chat: true } } }));
    expect(set).toEqual({
      winterExecutable: "/opt/winter/bin/winter",
      advisorModel: "some-model",
      idleTimeoutSec: 60,
      winterLeg: { chat: true, dispatch: true, code: true },
    });
  });

  test("the schema default and the absent-block answer are the same number", () => {
    expect(Settings.parse({ ...base, runtimes: {} }).runtimes?.winterIdleTimeoutSec).toBe(DEFAULT_WINTER_IDLE_TIMEOUT_SEC);
    expect(winterOptionsFromSettings(Settings.parse(base)).idleTimeoutSec).toBe(DEFAULT_WINTER_IDLE_TIMEOUT_SEC);
  });
});

// Pre-release hardening (P9c-1 amendment): the settings flag alone must never be able to widen the
// official leg's subscription posture — only ANDing it against the compile-time approval constant
// (`OFFICIAL_SUBSCRIPTION_AUTH_APPROVED`, versions.ts, real value `false`) does that. These tests
// use the function's own injectable `approved` override rather than the real constant, exactly the
// seam the constant's own doc says tests must use.
describe("officialSubscriptionAuthEnabled (P9c-1 amendment)", () => {
  const base = { schemaVersion: 3 as const, provider: { model: DEFAULT_PROVIDER.model } };

  test("null/undefined settings answer false, never a throw", () => {
    expect(officialSubscriptionAuthEnabled(null)).toBe(false);
    expect(officialSubscriptionAuthEnabled(undefined)).toBe(false);
  });

  test("an absent runtimes/official block answers false", () => {
    expect(officialSubscriptionAuthEnabled(Settings.parse(base))).toBe(false);
  });

  test("the flag true, with NO override -> false on the REAL compile-time constant (the shipped default, OFFICIAL_SUBSCRIPTION_AUTH_APPROVED = false)", () => {
    const on = Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: true } } });
    expect(officialSubscriptionAuthEnabled(on)).toBe(false);
  });

  test("the flag true, with the injectable override explicitly false -> still false", () => {
    const on = Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: true } } });
    expect(officialSubscriptionAuthEnabled(on, false)).toBe(false);
  });

  test("the flag true, with the injectable override true -> true (the only way to reach the widened branch)", () => {
    const on = Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: true } } });
    expect(officialSubscriptionAuthEnabled(on, true)).toBe(true);
  });

  test("the override alone, with the flag false/absent -> still false (approval without the flag never widens)", () => {
    expect(officialSubscriptionAuthEnabled(Settings.parse(base), true)).toBe(false);
    const off = Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: false } } });
    expect(officialSubscriptionAuthEnabled(off, true)).toBe(false);
  });
});

describe("officialSubscriptionAuthFlagInert (P9c-1 amendment)", () => {
  const base = { schemaVersion: 3 as const, provider: { model: DEFAULT_PROVIDER.model } };

  test("absent/false flag is never \"inert\" — it is simply off", () => {
    expect(officialSubscriptionAuthFlagInert(null)).toBe(false);
    expect(officialSubscriptionAuthFlagInert(Settings.parse(base))).toBe(false);
    const off = Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: false } } });
    expect(officialSubscriptionAuthFlagInert(off)).toBe(false);
  });

  test("flag true, on the real compile-time constant -> inert (true)", () => {
    const on = Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: true } } });
    expect(officialSubscriptionAuthFlagInert(on)).toBe(true);
  });

  test("flag true, WITH the approval override -> never inert (false) — approved means it's actually in effect, not stuck", () => {
    const on = Settings.parse({ ...base, runtimes: { official: { subscriptionAuth: true } } });
    expect(officialSubscriptionAuthFlagInert(on, true)).toBe(false);
  });
});

describe("setSkillDenied (daemon settings surface batch 3, item 2)", () => {
  const base = Settings.parse({ schemaVersion: 3 as const, provider: { model: DEFAULT_PROVIDER.model } });

  test("skillDenyRule spells the exact SDK-grammar string", () => {
    expect(skillDenyRule("writing-skills")).toBe("Skill(writing-skills)");
    expect(skillDenyRule("my-plugin:my-skill")).toBe("Skill(my-plugin:my-skill)");
  });

  test("denied: true appends the rule to an absent permissions block", () => {
    const next = setSkillDenied(base, "writing-skills", true);
    expect(next.permissions?.deny).toEqual(["Skill(writing-skills)"]);
  });

  test("denied: true is a no-op (deduped) when the rule already exists", () => {
    const once = setSkillDenied(base, "writing-skills", true);
    const twice = setSkillDenied(once, "writing-skills", true);
    expect(twice.permissions?.deny).toEqual(["Skill(writing-skills)"]);
  });

  test("denied: false removes only its own rule, preserving every other deny entry untouched", () => {
    const withTwo = Settings.parse({ ...base, permissions: { deny: ["Skill(writing-skills)", "Agent(fork)"] } });
    const next = setSkillDenied(withTwo, "writing-skills", false);
    expect(next.permissions?.deny).toEqual(["Agent(fork)"]);
  });

  test("denied: false on an absent rule is a no-op", () => {
    const next = setSkillDenied(base, "writing-skills", false);
    expect(next.permissions?.deny ?? []).toEqual([]);
  });

  test("preserves every other settings key untouched (a shallow-merge bug would drop provider/allow)", () => {
    const withAllow = Settings.parse({ ...base, permissions: { allow: ["Computer"] } });
    const next = setSkillDenied(withAllow, "writing-skills", true);
    expect(next.permissions?.allow).toEqual(["Computer"]);
    expect(next.provider).toEqual(base.provider);
  });
});
