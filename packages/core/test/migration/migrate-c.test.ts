// WS-21 L3.7 (spec §8): Migration C on a fixture home in the old layout — a Winter-leg session, an
// official-leg session whose `claude-config` working copy holds one extra trailing entry, a subagent,
// memory, provider-state, the moved settings keys, and a DeepSeek tag in provider.model, pins and
// selection_json. The router's reconcile is a stub here (its real outcomes are L2's, proven at R.2).
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { SessionStore } from "../../src/sessions/store";
import { tmpdir } from "node:os";
import { join, relative as relativeTo } from "node:path";
import {
  MigrationCRefused, finishMigrationC, isOldLayout, migrationCCompletePath, migrationCManifestPath, migrationCState,
  planMigrationC, rollbackMigrationC, runMigrationC,
} from "../../src/migration/migrate-c";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords } from "../../src/runtime-state/records";
import { convertLegacyPluginsForMigration } from "../../src/plugins/convert-legacy";
import { readSdkGlobalConfig, readSdkSettings } from "../../src/sdk-files";
import { canonicalModelTag, setCatalogKeysForTests } from "../../src/runtime-sdk/model-tag";
import { liveSettingsView, loadSettings } from "../../src/settings";

const OLD_TAG = "deepseek/deepseek-v4-flash";
afterEach(() => setCatalogKeysForTests(undefined));

const write = (p: string, body: string): void => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };

function fixture(opts: { officialExtra?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-migc-")));
  const key = "-Users-x-app";
  // the old layout: the runtime store at <home>/projects, skills at <home>/skills, agents, backups
  write(join(home, "projects", key, "s-winter.jsonl"), '{"type":"user","uuid":"u1"}\n');
  write(join(home, "projects", key, "s-winter", "subagents", "agent-a.jsonl"), '{"type":"user","uuid":"a1"}\n');
  write(join(home, "projects", key, "s-winter.provider-state.jsonl"), '{"opaque":true}\n');
  write(join(home, "projects", key, "memory", "MEMORY.md"), "- remembers\n");
  write(join(home, "projects", key, "s-official.jsonl"), '{"type":"user","uuid":"o1"}\n');
  write(join(home, "skills", "self", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
  write(join(home, "agents", "reviewer.md"), "---\nname: reviewer\n---\n");
  write(join(home, "backups", "s-winter", "a.bak"), "x");
  write(join(home, "WINTER.md"), "# my instructions\n");
  write(join(home, "history.jsonl"), `${JSON.stringify({ display: "hi", ts: 1700000000000, sessionId: "s_1" })}\n`);
  write(join(home, "mcp.json"), "{}"); // a dead legacy file
  // the official leg's working copy, one extra trailing entry past the canonical transcript
  if (opts.officialExtra !== false) {
    write(join(home, "runtimes", "claude-config", "projects", key, "s-official.jsonl"), '{"type":"user","uuid":"o1"}\n{"type":"assistant","uuid":"o2"}\n');
  }
  write(join(home, "permissions", "projects.json"), JSON.stringify({ version: 1, projects: { "/Users/x/app": ["Bash(make:*)"] } }));
  write(join(home, "cache", "skill-plugins", "p", "skills", "a", "SKILL.md"), "x");
  // bootstrap's own sdk/ (empty persistent dirs + sdk/projects)
  for (const d of ["projects", "file-history", "tasks", "teams", "agent-memory", "workflows"]) mkdirSync(join(home, "sdk", d), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    schemaVersion: 3, provider: { model: OLD_TAG }, pins: { dream: OLD_TAG },
    permissions: { allow: ["Bash(git status)", "Bash(rm *)"] }, outputStyle: "terse", memory: { enabled: true },
    mcpServers: { local: { type: "stdio", command: "node" } },
  }));
  // runtime-state: a Winter-leg row and an official row, backend_root in the OLD store
  const rs = openRuntimeStateDb(home);
  const ins = (id: string, kind: string, root: string) => rs.db.run(`INSERT INTO runtime_sessions (winter_session_id, runtime_kind, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
    transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json, active_local_write_root, active_local_write_root_kind)
    VALUES (?, ?, 'deepseek', ?, ?, ?, ?, ?, 'clean', 'conversation', 'c1', 'recorded', 't', 't', 'idle', ?, ?, ?)`,
    [id, kind, OLD_TAG, join(home, "projects", key), key, key, key, JSON.stringify({ runtimeKind: kind, providerId: "deepseek", modelRef: OLD_TAG, family: "deepseek", authFamily: "api-key", reason: "r", decidedAt: "t" }), root, root === null ? null : "official-spool"]);
  ins("s_1", "winter-agent", null as never);
  ins("s_2", "claude-agent", join(home, "runtimes", "claude-config"));
  rs.db.run("INSERT INTO runtime_generations (winter_session_id, generation, runtime_kind, started_at, config_dir) VALUES ('s_2', 1, 'claude-agent', 't', ?)", [join(home, "runtimes", "claude-config")]);
  rs.close();
  return { home, key };
}

const stubReconcile = (outcomes: Record<string, "clean" | "appended" | "quarantined"> = {}) => {
  const seen: string[] = [];
  return { seen, reconcile: async (root: string) => { seen.push(root); return outcomes[root] ?? "appended"; } };
};
const deps = (extra: Record<string, unknown> = {}) => ({ log: () => {}, reconcileAvailable: true, probe: { alive: () => false, startedAt: () => "unknown" }, ...extra });

describe("the old-layout definition (spec §8, r3)", () => {
  test("real projects/ or skills/ CONTENT; moved keys never count; a fresh home never matches", () => {
    const { home } = fixture();
    expect(isOldLayout(home)).toBe(true);
    const fresh = mkdtempSync(join(tmpdir(), "winter-migc-fresh-"));
    for (const d of ["projects", "skills/self", "sdk/projects"]) mkdirSync(join(fresh, d), { recursive: true });
    writeFileSync(join(fresh, "settings.json"), JSON.stringify({ schemaVersion: 3, permissions: { allow: ["Bash"] }, mcpServers: { a: { command: "x" } } }));
    expect(isOldLayout(fresh)).toBe(false);
  });
});

describe("review M7: every moved directory and the instructions file count", () => {
  for (const [what, seed, check] of [
    ["agents/", (h: string) => { mkdirSync(join(h, "agents"), { recursive: true }); writeFileSync(join(h, "agents", "a.md"), "x"); }, (h: string) => existsSync(join(h, "sdk", "agents", "a.md"))],
    ["workflows/", (h: string) => { mkdirSync(join(h, "workflows"), { recursive: true }); writeFileSync(join(h, "workflows", "w.js"), "x"); }, (h: string) => existsSync(join(h, "sdk", "workflows", "w.js"))],
    ["output-styles/", (h: string) => { mkdirSync(join(h, "output-styles"), { recursive: true }); writeFileSync(join(h, "output-styles", "o.md"), "x"); }, (h: string) => existsSync(join(h, "sdk", "output-styles", "o.md"))],
    ["backups/", (h: string) => { mkdirSync(join(h, "backups", "s"), { recursive: true }); writeFileSync(join(h, "backups", "s", "b"), "x"); }, (h: string) => existsSync(join(h, "sdk", "file-history", "s", "b"))],
    ["WINTER.md", (h: string) => { writeFileSync(join(h, "WINTER.md"), "# mine\n"); }, (h: string) => readFileSync(join(h, "sdk", "WINTER.md"), "utf8") === "# mine\n"],
  ] as const) {
    test(`a home with only ${what} is in the old layout, and migrates it`, async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-m7-")));
      mkdirSync(join(home, "sdk", "projects"), { recursive: true });
      seed(home);
      expect(isOldLayout(home)).toBe(true);
      expect((await runMigrationC(home, deps())).status).toBe("complete");
      expect(check(home)).toBe(true);
      expect(isOldLayout(home)).toBe(false);
    });
  }

  test("WINTER.md beside an existing sdk/WINTER.md is no old layout (nothing unread)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-m7b-")));
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "WINTER.md"), "a");
    writeFileSync(join(home, "sdk", "WINTER.md"), "b");
    expect(isOldLayout(home)).toBe(false);
  });
});

describe("preflight", () => {
  test("a LIVE lease refuses (pid running AND start time matching); a recycled pid does not", async () => {
    const { home } = fixture();
    const rs = openRuntimeStateDb(home);
    rs.db.run("UPDATE runtime_generations SET lease_holder_pid = 4242, lease_holder_started_at = '2026-09-23T00:00:00.000Z', lease_renewed_at = 't' WHERE winter_session_id = 's_2'");
    rs.close();
    const live = { alive: () => true, startedAt: () => "2026-09-23T00:00:00.000Z" };
    await expect(runMigrationC(home, deps({ probe: live }))).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    expect(existsSync(migrationCManifestPath(home))).toBe(false); // nothing moved, nothing recorded
    expect(lstatSync(join(home, "projects")).isDirectory()).toBe(true);
    const recycled = { alive: () => true, startedAt: () => "2026-09-23T09:99:00.000Z" };
    const m = await runMigrationC(home, deps({ probe: recycled }));
    expect(m.status).toBe("phase1-complete");
  });

  test("review I4: an UNKNOWN lease identity refuses too (never proven stale), and so does an unreadable store", async () => {
    const a = fixture();
    const rs = openRuntimeStateDb(a.home);
    rs.db.run("UPDATE runtime_generations SET lease_holder_pid = 4242, lease_holder_started_at = '2026-09-23T00:00:00.000Z', lease_renewed_at = 't' WHERE winter_session_id = 's_2'");
    rs.close();
    const unknownIdentity = { alive: () => true, startedAt: () => "unknown" };
    await expect(runMigrationC(a.home, deps({ probe: unknownIdentity }))).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    const b = fixture();
    writeFileSync(join(b.home, "runtimes", "runtime-state.db"), "not a database at all");
    for (const suffix of ["-wal", "-shm"]) rmSync(join(b.home, "runtimes", `runtime-state.db${suffix}`), { force: true });
    await expect(runMigrationC(b.home, deps())).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    expect(lstatSync(join(b.home, "projects")).isSymbolicLink()).toBe(false);
  });

  test("without a reconcile door, an official working copy with content refuses the whole migration", async () => {
    const { home } = fixture();
    await expect(runMigrationC(home, deps({ reconcileAvailable: false }))).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    // nothing for a router to reconcile: phase 2 needs no door, and the migration completes at once
    const empty = fixture({ officialExtra: false });
    expect((await runMigrationC(empty.home, deps({ reconcileAvailable: false }))).status).toBe("complete");
  });

  test("plugins without a converter refuse; sdk/ with unexpected content refuses", async () => {
    const a = fixture();
    mkdirSync(join(a.home, "plugins", "battery-limiter"), { recursive: true });
    await expect(runMigrationC(a.home, deps())).rejects.toBeInstanceOf(MigrationCRefused);
    const b = fixture();
    writeFileSync(join(b.home, "sdk", "projects", "stray.jsonl"), "x");
    await expect(runMigrationC(b.home, deps())).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    const c = fixture();
    writeFileSync(join(c.home, "sdk", "settings.json"), "{}"); // what the settings doors write on any build is fine
    expect((await runMigrationC(c.home, deps())).status).toBe("phase1-complete");
  });
});

// Post-merge round (BLOCKING): convertLegacyPluginsForMigration (plugins/convert-legacy.ts) is the
// real seam this lane wires in at daemon.ts's boot hook and cli/src/commands/migrate.ts — a home with
// a legacy plugin such as battery-limiter must boot (never refuse) and end up with it converted.
describe("BLOCKING: convertLegacyPlugins wired into Migration C's convert-plugins step", () => {
  test("a home with a legacy plugin (battery-limiter-shaped) migrates end to end: converted, original kept, manifest records it", async () => {
    const { home } = fixture();
    mkdirSync(join(home, "plugins", "battery-limiter"), { recursive: true });
    writeFileSync(join(home, "plugins", "battery-limiter", "winter-plugin.json"), JSON.stringify({
      id: "battery-limiter", tier: "capability", permissions: { hardware: ["battery"] },
    }));
    // The legacy home had this plugin ENABLED — convertLegacyPlugins reads plugins.enabled/disabled
    // off the LEGACY settings.json to decide the converted plugin's enabled state (see its own doc).
    const legacySettings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ ...legacySettings, plugins: { enabled: ["battery-limiter"] } }));

    const m = await runMigrationC(home, deps({
      reconcile: stubReconcile().reconcile,
      convertLegacyPlugins: convertLegacyPluginsForMigration,
    }));
    expect(m.status).toBe("complete");

    const step = m.steps.find((s) => s.step === "convert-plugins");
    expect(step?.status).toBe("done");
    expect(step?.detail).toEqual({ converted: ["battery-limiter"], unconvertible: [] });

    // COPY, never move (spec §2.1/§8's "originals kept for downgrade") — the legacy directory is
    // untouched, not archived, not deleted, not even a symlink.
    expect(lstatSync(join(home, "plugins", "battery-limiter")).isDirectory()).toBe(true);
    expect(existsSync(join(home, "plugins", "battery-limiter", "winter-plugin.json"))).toBe(true);

    // Registered through Contract B under the shared sdk/ home, converted+enabled.
    const installed = JSON.parse(readFileSync(join(home, "sdk", "plugins", "installed_plugins.json"), "utf8"));
    expect(installed.plugins["battery-limiter@winter-legacy"]).toBeDefined();
    const sdkSettings = JSON.parse(readFileSync(join(home, "sdk", "settings.json"), "utf8"));
    expect(sdkSettings.enabledPlugins["battery-limiter@winter-legacy"]).toBe(true);
  });

  test("a home with an ALREADY-converted plugin from a prior partial run does not refuse on resume", async () => {
    // Idempotency check for the wired-in step: convertLegacyPlugins itself re-registers the same
    // marketplace/install records on a re-run (its own doc: "idempotent... overwrites the SAME
    // converted target dirs") — running the whole migration TWICE against the same home (as a resume
    // after an interrupted convert-plugins step would) must not refuse or duplicate.
    const { home } = fixture();
    mkdirSync(join(home, "plugins", "battery-limiter"), { recursive: true });
    writeFileSync(join(home, "plugins", "battery-limiter", "winter-plugin.json"), JSON.stringify({
      id: "battery-limiter", tier: "capability", permissions: { hardware: ["battery"] },
    }));
    const migrationDeps = deps({ reconcile: stubReconcile().reconcile, convertLegacyPlugins: convertLegacyPluginsForMigration });

    const first = await runMigrationC(home, migrationDeps);
    expect(first.status).toBe("complete");
    // convert-plugins is only ever run ONCE per migration (guarded by `done("convert-plugins")`) — a
    // second runMigrationC call on an already-complete home is a pure no-op that returns the same
    // manifest, proving the step's own idempotency claim never even needs re-exercising here.
    const second = await runMigrationC(home, migrationDeps);
    expect(second.status).toBe("complete");
    expect(second.steps.filter((s) => s.step === "convert-plugins")).toHaveLength(1);
  });
});

/** An older build's store: `user_version` 6 and the v6 CHECK (no `run-folder`), rows kept. */
function rewindToV6(home: string): void {
  const db = new Database(join(home, "runtimes", "runtime-state.db"));
  db.run("PRAGMA foreign_keys = OFF");
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_sessions'").get()!.sql;
  db.run(sql.replace("IN ('official-spool','sdk-resume-staging','run-folder')", "IN ('official-spool','sdk-resume-staging')").replace(/^CREATE TABLE "?runtime_sessions"?/, "CREATE TABLE runtime_sessions_old"));
  db.run("INSERT INTO runtime_sessions_old SELECT * FROM runtime_sessions");
  db.run("DROP TABLE runtime_sessions");
  db.run("ALTER TABLE runtime_sessions_old RENAME TO runtime_sessions");
  db.run("CREATE INDEX IF NOT EXISTS runtime_sessions_state ON runtime_sessions(state)");
  db.run("DROP TABLE IF EXISTS run_root_quarantine");
  db.run("PRAGMA user_version = 6");
  db.close();
}
const userVersion = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try { return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; } finally { db.close(); }
};

describe("review I2: the pre-migration backup is the pre-migration schema", () => {
  test("a v6 store is backed up as v6 (read-only open, VACUUM INTO) — never bumped first", async () => {
    const { home } = fixture();
    rewindToV6(home);
    const m = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(m.backups.runtimeState).not.toBeNull();
    expect(userVersion(m.backups.runtimeState!)).toBe(6);
  });
});

describe("round 3, minor 8: a preflight backup that fails is a typed refusal", () => {
  test("an unreadable file to back up refuses typed — no manifest, no archive dir, nothing moved", async () => {
    const { home, key } = fixture();
    writeFileSync(join(home, "sdk", "settings.json"), "{}");
    chmodSync(join(home, "sdk", "settings.json"), 0o000);
    try {
      await expect(runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }))).rejects.toMatchObject({ name: "MigrationCRefused", code: "sdk_home_migration_refused" });
    } finally { chmodSync(join(home, "sdk", "settings.json"), 0o600); }
    expect(migrationCState(home)).toEqual({ kind: "absent" });
    expect(readdirSync(join(home, "migration")).filter((n) => n.startsWith("c-"))).toEqual([]);
    expect(lstatSync(join(home, "projects", key)).isDirectory()).toBe(true);
    expect(isOldLayout(home)).toBe(true);
  });
});

describe("review I1: a rolled-back home can migrate again", () => {
  test("whatever the new build wrote into sdk/ after the upgrade is no collision; only a compat target with content beside an old dir with content is", async () => {
    const { home, key } = fixture();
    await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    // the new build ran for a while…
    for (const [d, f] of [["tasks", "t.json"], ["teams", "t.json"], ["agent-memory", "m.md"], ["file-history", "s/x.bak"], ["plugins", "p/plugin.json"], ["commands", "c.md"]]) {
      mkdirSync(join(home, "sdk", d!, f!.includes("/") ? f!.split("/")[0]! : ""), { recursive: true });
      writeFileSync(join(home, "sdk", d!, f!), "x");
    }
    await rollbackMigrationC(home, { log: () => {} });
    expect(isOldLayout(home)).toBe(true);
    // …and the next boot of the new build migrates it again rather than refusing forever
    const again = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(again.status).toBe("complete");
    expect(existsSync(join(home, "sdk", "projects", key, "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(home, "sdk", "tasks", "t.json"))).toBe(true);
  });

  test("a real collision still refuses: an old dir with content AND its sdk target with content", async () => {
    const { home, key } = fixture();
    mkdirSync(join(home, "sdk", "skills", "other"), { recursive: true });
    writeFileSync(join(home, "sdk", "skills", "other", "SKILL.md"), "x");
    await expect(runMigrationC(home, deps())).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    expect(lstatSync(join(home, "projects", key)).isDirectory()).toBe(true);
  });

  // Round 3, minor 2: the preflight's hint named `--resume`, but at preflight there is no manifest to
  // resume — the remedy is to resolve the pair by hand and run the migration again.
  test("round 3: the preflight collision hint names the real remedy (no manifest exists yet to resume)", async () => {
    const { home } = fixture();
    mkdirSync(join(home, "sdk", "skills", "other"), { recursive: true });
    writeFileSync(join(home, "sdk", "skills", "other", "SKILL.md"), "x");
    const err = await runMigrationC(home, deps()).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("--resume");
    expect((err as Error).message).toContain("by hand");
    expect((err as Error).message).toContain("winter migrate --sdk-home");
    expect(migrationCState(home)).toEqual({ kind: "absent" });
  });

  // Round 3, minor 2: after a rollback the older build writes into the old directory while the sdk/ side
  // keeps what the new build wrote there (a target the first run only LINKED, so rollback left it) — a
  // re-upgrade would refuse forever. On a rolled-back home the sdk/ side is DISPLACED into this migration's
  // archive instead (recorded; rollback puts it back); anywhere else a collision still refuses.
  test("round 3: a rolled-back home whose old dir AND sdk target both gained content re-migrates: the sdk side is displaced, and rollback restores it", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-migc-displace-")));
    mkdirSync(join(home, "sdk", "projects"), { recursive: true });
    mkdirSync(join(home, "backups"), { recursive: true });               // an EMPTY old dir: linked, not moved
    write(join(home, "skills", "s", "SKILL.md"), "x");                    // something to migrate
    const first = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(first.moved.map((mv) => mv.from)).not.toContain("backups");
    write(join(home, "sdk", "file-history", "new-session", "n.bak"), "new build");   // through the link
    await rollbackMigrationC(home, { log: () => {} });
    expect(existsSync(join(home, "sdk", "file-history", "new-session", "n.bak"))).toBe(true); // a link's target is never moved back
    write(join(home, "backups", "old-session", "o.bak"), "old build");     // the older build, after the rollback
    const again = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(again.status).toBe("complete");
    expect(again.displaced).toEqual([{ from: "sdk/file-history", to: join(relativeTo(home, again.archiveDir), "displaced", "sdk", "file-history") }]);
    expect(readFileSync(join(home, "sdk", "file-history", "old-session", "o.bak"), "utf8")).toBe("old build");
    expect(readFileSync(join(again.archiveDir, "displaced", "sdk", "file-history", "new-session", "n.bak"), "utf8")).toBe("new build");
    await rollbackMigrationC(home, { log: () => {} });
    expect(readFileSync(join(home, "backups", "old-session", "o.bak"), "utf8")).toBe("old build");
    expect(readFileSync(join(home, "sdk", "file-history", "new-session", "n.bak"), "utf8")).toBe("new build");
  });

  test("an EMPTY old dir beside a target with content is linked, not refused", async () => {
    const { home } = fixture();
    mkdirSync(join(home, "workflows"), { recursive: true });           // empty old dir
    mkdirSync(join(home, "sdk", "workflows"), { recursive: true });
    writeFileSync(join(home, "sdk", "workflows", "w.js"), "x");          // the new build's content
    const m = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(m.status).toBe("complete");
    expect(lstatSync(join(home, "workflows")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "workflows", "w.js"))).toBe(true);
  });
});

describe("both phases", () => {
  test("every step's effect; old paths are links; the extra official entry is reconciled; tags stay stored", async () => {
    const { home, key } = fixture();
    const stub = stubReconcile();
    const m = await runMigrationC(home, deps({ reconcile: stub.reconcile }));
    expect(m.status).toBe("complete");
    expect(existsSync(migrationCCompletePath(home))).toBe(true);
    // move-dirs: content in sdk/, relative links at the old paths
    for (const [name, target] of [["projects", "sdk/projects"], ["skills", "sdk/skills"], ["agents", "sdk/agents"], ["backups", "sdk/file-history"]]) {
      expect(lstatSync(join(home, name!)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, name!))).toBe(target!);
    }
    expect(readFileSync(join(home, "sdk", "projects", key, "memory", "MEMORY.md"), "utf8")).toBe("- remembers\n");
    expect(existsSync(join(home, "sdk", "projects", key, "s-winter", "subagents", "agent-a.jsonl"))).toBe(true);
    expect(existsSync(join(home, "sdk", "projects", key, "s-winter.provider-state.jsonl"))).toBe(true);
    expect(existsSync(join(home, "sdk", "skills", "self", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "sdk", "file-history", "s-winter", "a.bak"))).toBe(true);
    // copy-files
    expect(readFileSync(join(home, "sdk", "WINTER.md"), "utf8")).toBe("# my instructions\n");
    expect(JSON.parse(readFileSync(join(home, "sdk", "history.jsonl"), "utf8").trim())).toEqual({ display: "hi", pastedContents: {}, timestamp: 1700000000000, project: "", sessionId: "s_1" });
    // split-settings
    expect((readSdkSettings(home) as Record<string, any>).permissions.allow).toEqual(["Bash(git status)"]);
    expect((readSdkSettings(home) as Record<string, any>).outputStyle).toBe("terse");
    expect((readSdkGlobalConfig(home) as Record<string, any>).mcpServers.local).toEqual({ type: "stdio", command: "node" });
    // phase 2: the official working copy went through the router's door, then into the archive
    expect(stub.seen).toEqual([join(home, "runtimes", "claude-config")]);
    expect(m.reconciled).toEqual([{ root: join(home, "runtimes", "claude-config"), outcome: "appended" }]);
    expect(existsSync(join(home, "runtimes", "claude-config"))).toBe(false);
    for (const gone of ["permissions", "cache/skill-plugins", "mcp.json"]) expect(existsSync(join(home, gone))).toBe(false);
    expect(existsSync(join(m.archiveDir, "archive", "permissions", "projects.json"))).toBe(true);
    // runtime-state: backend_root rewritten, the stale official bookkeeping cleared
    const rs = openRuntimeStateDb(home);
    const rows = rs.db.query<{ id: string; b: string; r: string | null }, []>("SELECT winter_session_id AS id, backend_root AS b, active_local_write_root AS r FROM runtime_sessions ORDER BY id").all();
    expect(rows.map((r) => r.b)).toEqual([join(home, "sdk", "projects", key), join(home, "sdk", "projects", key)]);
    expect(rows[1]!.r).toBeNull();
    expect(rs.db.query<{ c: string | null }, []>("SELECT config_dir AS c FROM runtime_generations").get()!.c).toBeNull();
    // tags stay as stored…
    expect(rs.db.query<{ m: string }, []>("SELECT model_ref AS m FROM runtime_sessions WHERE winter_session_id='s_1'").get()!.m).toBe(OLD_TAG);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).provider.model).toBe(OLD_TAG);
    // …and resolve to …/deepseek-flash at read time against the refreshed catalog
    setCatalogKeysForTests(["deepseek/deepseek-flash", "deepseek-anthropic/deepseek-flash"]);
    expect(new RuntimeSessionRecords(rs).get("s_1")!.modelRef).toBe("deepseek/deepseek-flash");
    expect((new RuntimeSessionRecords(rs).get("s_1")!.selection as { modelRef: string }).modelRef).toBe("deepseek/deepseek-flash");
    const view = liveSettingsView(loadSettings(join(home, "settings.json")));
    expect(view.provider.model as string).toBe("deepseek/deepseek-flash");
    expect(view.pins?.dream as string).toBe("deepseek/deepseek-flash");
    expect(canonicalModelTag(OLD_TAG)).toBe("deepseek/deepseek-flash");
    rs.close();
  });

  test("a re-run does nothing", async () => {
    const { home } = fixture();
    const first = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    const again = stubReconcile();
    const second = await runMigrationC(home, deps({ reconcile: again.reconcile }));
    expect(second.steps).toEqual(first.steps);
    expect(again.seen).toEqual([]);
    expect(isOldLayout(home)).toBe(false);
    expect((await planMigrationC(home)).needed).toBe(false);
  });

  test("phase 1 alone is a booting state; phase 2 finishes it later", async () => {
    const { home } = fixture();
    const m1 = await runMigrationC(home, deps());
    expect(m1.status).toBe("phase1-complete");
    expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "phase1-complete" } });
    expect(existsSync(join(home, "runtimes", "claude-config"))).toBe(true); // not archived before its reconcile
    // no door yet, and a working copy with content: refused, never archived unreconciled
    await expect(finishMigrationC(home, { log: () => {} })).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    expect(existsSync(join(home, "runtimes", "claude-config"))).toBe(true);
    const m2 = await finishMigrationC(home, { log: () => {}, reconcile: stubReconcile().reconcile });
    expect(m2.status).toBe("complete");
  });

  test("a quarantined or failed official root is still archived (a move — nothing is lost)", async () => {
    const { home } = fixture();
    const root = join(home, "runtimes", "claude-config");
    const m = await runMigrationC(home, deps({ reconcile: async () => { throw new Error("run_home_link_refused"); } }));
    expect(m.reconciled).toEqual([{ root, outcome: "failed", reason: "Error" }]);
    expect(existsSync(join(m.archiveDir, "archive", "runtimes", "claude-config", "projects"))).toBe(true);
  });

  // Round 3, minor 7: a root whose reconcile THREW is archived unreconciled — so every session with a
  // transcript under it (a subagent's included) is marked repair-required, not left looking clean.
  test("round 3: a reconcile that throws marks every session with a transcript under that root repair-required", async () => {
    const { home, key } = fixture();
    write(join(home, "runtimes", "claude-config", "projects", key, "be-sub", "subagents", "agent-x.jsonl"), "{}\n");
    const rs0 = openRuntimeStateDb(home);
    rs0.db.run("UPDATE runtime_sessions SET backend_session_id = 's-official' WHERE winter_session_id = 's_2'");
    rs0.db.run("UPDATE runtime_sessions SET backend_session_id = 'be-sub' WHERE winter_session_id = 's_1'");
    rs0.db.run(`INSERT INTO runtime_sessions (winter_session_id, runtime_kind, backend_session_id, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
      transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json)
      SELECT 's_3', runtime_kind, 'be-elsewhere', provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
      'clean', compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json FROM runtime_sessions WHERE winter_session_id = 's_1'`);
    rs0.close();
    const logs: string[] = [];
    await runMigrationC(home, deps({ reconcile: async () => { throw new Error("boom"); }, log: (l: string) => logs.push(l) }));
    const rs = openRuntimeStateDb(home);
    const health = (id: string) => rs.db.query<{ h: string }, [string]>("SELECT transcript_health AS h FROM runtime_sessions WHERE winter_session_id = ?").get(id)!.h;
    expect([health("s_1"), health("s_2"), health("s_3")]).toEqual(["repair-required", "repair-required", "clean"]);
    rs.close();
    expect(logs.some((l) => l.includes("repair-required") && l.includes("s_2"))).toBe(true);
  });
});

// Review I6 (`ws21/router`@7c57f9a): phase 2 acts on each transcript's own outcome — `canonical-ahead`
// (the normal state for a resumed or cross-leg official session) needs nothing; a session is marked
// repair-required only when one of ITS transcripts was quarantined; the root is never one unit.
describe("review I6: phase 2 per transcript", () => {
  test("only the quarantined transcript's session is marked; canonical-ahead and appended are fine; the root is archived", async () => {
    const { home } = fixture();
    const rs0 = openRuntimeStateDb(home);
    rs0.db.run("UPDATE runtime_sessions SET backend_session_id = 'be-2' WHERE winter_session_id = 's_2'");
    rs0.db.run("UPDATE runtime_sessions SET backend_session_id = 'be-1' WHERE winter_session_id = 's_1'");
    rs0.close();
    const m = await runMigrationC(home, deps({
      reconcile: async () => ({
        outcome: "quarantined" as const,
        transcripts: [
          { projectKey: "k", sessionId: "be-1", outcome: "canonical-ahead" as const, appended: 0 },
          { projectKey: "k", sessionId: "be-2", outcome: "quarantined" as const, appended: 0, reason: "diverged" },
        ],
      }),
    }));
    expect(m.status).toBe("complete");
    expect(m.reconciled[0]!.transcripts?.map((t) => [t.sessionId, t.outcome])).toEqual([["be-1", "canonical-ahead"], ["be-2", "quarantined"]]);
    const rs = openRuntimeStateDb(home);
    const health = (id: string) => rs.db.query<{ h: string }, [string]>("SELECT transcript_health AS h FROM runtime_sessions WHERE winter_session_id = ?").get(id)!.h;
    expect([health("s_1"), health("s_2")]).toEqual(["clean", "repair-required"]);
    rs.close();
    expect(existsSync(join(home, "runtimes", "claude-config"))).toBe(false); // archived as a whole directory, never "quarantined as a unit"
  });

  test("canonical-ahead everywhere: nothing marked", async () => {
    const { home } = fixture();
    const m = await runMigrationC(home, deps({ reconcile: async () => ({ outcome: "clean" as const, transcripts: [{ projectKey: "k", sessionId: "be-x", outcome: "canonical-ahead" as const, appended: 0 }] }) }));
    const rs = openRuntimeStateDb(home);
    expect(rs.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runtime_sessions WHERE transcript_health = 'repair-required'").get()!.n).toBe(0);
    rs.close();
    expect(m.reconciled[0]!.outcome).toBe("clean");
  });
});

// Round 3, minor 3: move-dirs records a move only when it PROVABLY happened — the intent is written before
// the rename and checked after it. The old "the target has files, so it must be this move's" guess stopped
// being true once I1 let the new build's own content sit in a target.
describe("round 3, minor 3: move-dirs never claims a move that did not happen", () => {
  test("the new build's content in a target with no old directory is never recorded as moved (nor linked, nor carried back by rollback)", async () => {
    const { home } = fixture();
    mkdirSync(join(home, "sdk", "output-styles"), { recursive: true });
    writeFileSync(join(home, "sdk", "output-styles", "mine.md"), "x");       // the new build wrote it; no old dir
    const m = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(m.moved.map((mv) => mv.from)).not.toContain("output-styles");
    expect(existsSync(join(home, "output-styles"))).toBe(false);
    await rollbackMigrationC(home, { log: () => {} });
    expect(existsSync(join(home, "sdk", "output-styles", "mine.md"))).toBe(true);   // left where the new build put it
    expect(existsSync(join(home, "output-styles"))).toBe(false);
  });

  const inProgress = (home: string, moving: { from: string; to: string }) => {
    const archiveDir = join(home, "migration", "c-test");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(migrationCManifestPath(home), JSON.stringify({
      schemaVersion: 1, home, startedAt: new Date(0).toISOString(), status: "in-progress", archiveDir,
      steps: [{ step: "preflight", status: "done", at: new Date(0).toISOString() }],
      backups: { settings: null, runtimeState: null, sdkSettings: null, sdkGlobal: null, splitMarker: null },
      moved: [], links: [], copied: [], archived: [], reconciled: [], moving,
    }));
  };

  test("a crash AFTER the rename (the intent recorded, the old path gone) is recorded on resume, then linked", async () => {
    const { home } = fixture();
    mkdirSync(join(home, "migration", "c"), { recursive: true });
    inProgress(home, { from: "skills", to: "sdk/skills" });
    renameSync(join(home, "skills"), join(home, "sdk", "skills"));
    const m = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(m.moved).toContainEqual({ from: "skills", to: "sdk/skills" });
    expect(m.moving).toBeUndefined();
    expect(lstatSync(join(home, "skills")).isSymbolicLink()).toBe(true);
    await rollbackMigrationC(home, { log: () => {} });
    expect(existsSync(join(home, "skills", "self", "deploy", "SKILL.md"))).toBe(true);
  });

  test("a crash BEFORE the rename (the intent recorded, the old path still there) simply moves it", async () => {
    const { home } = fixture();
    mkdirSync(join(home, "migration", "c"), { recursive: true });
    inProgress(home, { from: "skills", to: "sdk/skills" });
    const m = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(m.moved.filter((mv) => mv.from === "skills")).toEqual([{ from: "skills", to: "sdk/skills" }]);
    expect(existsSync(join(home, "sdk", "skills", "self", "deploy", "SKILL.md"))).toBe(true);
  });
});

describe("review M4: the archive's crash window", () => {
  test("an item renamed into the archive before the manifest recorded it is found, recorded, and restored by rollback", async () => {
    const { home } = fixture();
    const m1 = await runMigrationC(home, deps());
    expect(m1.status).toBe("phase1-complete");
    // a crash right after the rename of `permissions/`, before the manifest write
    const dest = join(m1.archiveDir, "archive", "permissions");
    mkdirSync(join(m1.archiveDir, "archive"), { recursive: true });
    renameSync(join(home, "permissions"), dest);
    const m2 = await finishMigrationC(home, { log: () => {}, reconcile: stubReconcile().reconcile });
    expect(m2.archived.map((a) => a.from)).toContain("permissions");
    await rollbackMigrationC(home, { log: () => {} });
    expect(existsSync(join(home, "permissions", "projects.json"))).toBe(true);
  });
});

describe("rollback", () => {
  test("restores the layout except the step-2 appends, and never reverts what the user did after the upgrade (DECISION 15)", async () => {
    const { home, key } = fixture();
    const settingsBefore = readFileSync(join(home, "settings.json"), "utf8");
    await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    // after the upgrade: the user edits settings.json, and a new generation is recorded
    writeFileSync(join(home, "settings.json"), settingsBefore.replace('"terse"', '"explanatory"'));
    { const rs = openRuntimeStateDb(home); rs.db.run("INSERT INTO runtime_generations (winter_session_id, generation, runtime_kind, started_at) VALUES ('s_1', 7, 'winter-agent', 't')"); rs.close(); }
    // the router's append landed in the canonical transcript (now under sdk/)
    writeFileSync(join(home, "sdk", "projects", key, "s-official.jsonl"), '{"type":"user","uuid":"o1"}\n{"type":"assistant","uuid":"o2"}\n');
    const m = await rollbackMigrationC(home, { log: () => {} });
    expect(m.status).toBe("rolled-back");
    for (const name of ["projects", "skills", "agents", "backups"]) expect(lstatSync(join(home, name)).isDirectory()).toBe(true);
    expect(readFileSync(join(home, "projects", key, "memory", "MEMORY.md"), "utf8")).toBe("- remembers\n");
    // the append stays
    expect(readFileSync(join(home, "projects", key, "s-official.jsonl"), "utf8")).toContain('"o2"');
    // archived items back; copies and sdk files gone; the working copy back
    expect(existsSync(join(home, "permissions", "projects.json"))).toBe(true);
    expect(existsSync(join(home, "mcp.json"))).toBe(true);
    expect(existsSync(join(home, "runtimes", "claude-config", "projects", key, "s-official.jsonl"))).toBe(true);
    expect(existsSync(join(home, "sdk", "WINTER.md"))).toBe(false);
    expect(existsSync(join(m.archiveDir, "rolled-back", "sdk", "WINTER.md"))).toBe(true); // moved aside, never deleted
    // the split's sdk files stay (an older build never reads them; they may hold post-upgrade answers)
    expect(existsSync(join(home, "sdk", "settings.json"))).toBe(true);
    expect(existsSync(join(home, "sdk", "projects"))).toBe(true); // bootstrap's placeholder
    expect(readFileSync(join(home, "settings.json"), "utf8")).toContain('"explanatory"'); // the user's edit is kept
    // review I3: the store is back at schema v6, so the older build opens it
    expect(userVersion(join(home, "runtimes", "runtime-state.db"))).toBe(6);
    // runtime-state: the one rewrite reversed; a row written after the upgrade survives the rollback
    const rs = openRuntimeStateDb(home);
    expect(rs.db.query<{ b: string }, []>("SELECT backend_root AS b FROM runtime_sessions WHERE winter_session_id='s_1'").get()!.b).toBe(join(home, "projects", key));
    expect(rs.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runtime_generations WHERE generation = 7").get()!.n).toBe(1);
    rs.close();
    expect(isOldLayout(home)).toBe(true);
    expect(existsSync(migrationCManifestPath(home))).toBe(false);
    await expect(rollbackMigrationC(home, { log: () => {} })).rejects.toMatchObject({ code: "nothing_to_rollback" });
  });

  // Round 3, minor 1: the schema step runs FIRST — a store that cannot step back to v6 refuses the rollback
  // typed with nothing restored, reversed or moved (it used to run after the archive restore and the
  // backend_root reversal, leaving a half-rolled-back home behind).
  test("the v7→v6 step runs first: a store that cannot step back refuses typed, with NOTHING undone", async () => {
    const { home, key } = fixture();
    await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    { const db = new Database(join(home, "runtimes", "runtime-state.db")); db.run("PRAGMA user_version = 8"); db.close(); } // a newer build's store
    await expect(rollbackMigrationC(home, { log: () => {} })).rejects.toMatchObject({ name: "MigrationCRefused", code: "sdk_home_migration_refused" });
    expect(existsSync(join(home, "permissions"))).toBe(false);                                  // the archive not restored
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(true);                     // move-dirs not reversed
    expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "complete" } });
    const db = new Database(join(home, "runtimes", "runtime-state.db"), { readonly: true });
    try { expect(db.query<{ b: string }, []>("SELECT backend_root AS b FROM runtime_sessions WHERE winter_session_id='s_1'").get()!.b).toBe(join(home, "sdk", "projects", key)); } finally { db.close(); }
  });
});

// WS-21 round 3 (Important): the BULK canonical-cwd re-key. A 0.116 session made in a symlinked cwd keeps
// its transcript under the RAW cwd's key; both legs now look under the realpath's. Phase 2 moves every such
// session's files (after the reconcile, which judges each working copy against the canonical file at the
// key 0.116 wrote), re-points the record, records each move for rollback, and marks a collision.
describe("round 3: the bulk canonical-cwd re-key", () => {
  const BACKEND = "7c4f1c2e-aaaa-4bbb-8ccc-ddddeeeeffff";
  const COLLIDING = "7c4f1c2e-1111-4bbb-8ccc-ddddeeeeffff";
  function symlinkedFixture() {
    const f = fixture();
    const real = realpathSync(mkdtempSync(join(tmpdir(), "winter-migc-real-")));
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-migc-link-"))), "proj");
    symlinkSync(real, link);
    const rawKey = transcriptProjectKey(link);
    const canonKey = transcriptProjectKey(real);
    expect(rawKey).not.toBe(canonKey);
    const store = new SessionStore(f.home);
    const moving = store.createSession("t", { mode: "code", cwd: link });
    const colliding = store.createSession("t", { mode: "code", cwd: link });
    store.close();
    write(join(f.home, "projects", rawKey, `${BACKEND}.jsonl`), '{"type":"user","uuid":"m1"}\n');
    write(join(f.home, "projects", rawKey, `${BACKEND}.provider-state.jsonl`), "{}\n");
    write(join(f.home, "projects", rawKey, BACKEND, "subagents", "agent-a.jsonl"), "{}\n");
    write(join(f.home, "projects", rawKey, `${COLLIDING}.jsonl`), '{"type":"user","uuid":"c-old"}\n');
    write(join(f.home, "projects", canonKey, `${COLLIDING}.jsonl`), '{"type":"user","uuid":"c-new"}\n');
    const rs = openRuntimeStateDb(f.home);
    for (const [sid, backend] of [[moving, BACKEND], [colliding, COLLIDING]] as const) {
      rs.db.run(`INSERT INTO runtime_sessions (winter_session_id, runtime_kind, backend_session_id, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
        transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json)
        VALUES (?, 'winter-agent', ?, 'deepseek', ?, ?, ?, ?, ?, 'clean', 'conversation', 'c1', 'recorded', 't', 't', 'idle', ?)`,
        [sid, backend, OLD_TAG, join(f.home, "projects", rawKey), rawKey, rawKey, rawKey, JSON.stringify({ runtimeKind: "winter-agent", providerId: "deepseek", modelRef: OLD_TAG, family: "deepseek", authFamily: "api-key", reason: "r", decidedAt: "t" })]);
    }
    rs.close();
    return { ...f, moving, colliding, rawKey, canonKey };
  }
  const row = (home: string, sid: string) => {
    const rs = openRuntimeStateDb(home);
    try { return rs.db.query<{ k: string; b: string; h: string }, [string]>("SELECT transcript_project_key AS k, backend_root AS b, transcript_health AS h FROM runtime_sessions WHERE winter_session_id = ?").get(sid)!; } finally { rs.close(); }
  };

  test("moves the transcript, sidecars and subagents to the canonical key, re-points the record, records the move — after the reconcile", async () => {
    const { home, moving, rawKey, canonKey } = symlinkedFixture();
    const m = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    expect(m.status).toBe("complete");
    const sdkProjects = join(home, "sdk", "projects");
    expect(readFileSync(join(sdkProjects, canonKey, `${BACKEND}.jsonl`), "utf8")).toContain("m1");
    expect(existsSync(join(sdkProjects, canonKey, `${BACKEND}.provider-state.jsonl`))).toBe(true);
    expect(existsSync(join(sdkProjects, canonKey, BACKEND, "subagents", "agent-a.jsonl"))).toBe(true);
    expect(existsSync(join(sdkProjects, rawKey, `${BACKEND}.jsonl`))).toBe(false);
    expect(row(home, moving)).toMatchObject({ k: canonKey, b: join(sdkProjects, canonKey), h: "clean" });
    const entry = m.rekeyed?.find((e) => e.sessionId === moving);
    expect(entry).toMatchObject({ backendId: BACKEND, from: rawKey, to: canonKey, outcome: "moved" });
    expect(entry!.entries.at(-1)).toBe(`${BACKEND}.jsonl`);
    const steps = m.steps.map((s) => s.step);
    expect(steps.indexOf("reconcile-official-roots")).toBeLessThan(steps.indexOf("rekey-transcripts"));
    expect(steps.indexOf("rekey-transcripts")).toBeLessThan(steps.indexOf("archive"));
    // the fixture's own sessions (no sessions-index cwd) and the Users-x-app key are untouched
    expect(existsSync(join(sdkProjects, "-Users-x-app", "s-winter.jsonl"))).toBe(true);
  });

  test("a collision (both keys hold the transcript) moves nothing, marks the session repair-required and records it", async () => {
    const { home, colliding, rawKey, canonKey } = symlinkedFixture();
    const logs: string[] = [];
    const m = await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile, log: (l: string) => logs.push(l) }));
    const sdkProjects = join(home, "sdk", "projects");
    expect(readFileSync(join(sdkProjects, rawKey, `${COLLIDING}.jsonl`), "utf8")).toContain("c-old");
    expect(readFileSync(join(sdkProjects, canonKey, `${COLLIDING}.jsonl`), "utf8")).toContain("c-new");
    expect(row(home, colliding)).toMatchObject({ k: rawKey, h: "repair-required" });
    expect(m.rekeyed?.find((e) => e.sessionId === colliding)).toMatchObject({ outcome: "collision" });
    expect(logs.some((l) => l.includes("collision") && l.includes(colliding))).toBe(true);
  });

  test("rollback moves the files back under the raw key and re-points the record", async () => {
    const { home, moving, colliding, rawKey, canonKey } = symlinkedFixture();
    await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
    await rollbackMigrationC(home, { log: () => {} });
    expect(readFileSync(join(home, "projects", rawKey, `${BACKEND}.jsonl`), "utf8")).toContain("m1");
    expect(existsSync(join(home, "projects", rawKey, BACKEND, "subagents", "agent-a.jsonl"))).toBe(true);
    expect(existsSync(join(home, "projects", canonKey, `${BACKEND}.jsonl`))).toBe(false);
    expect(row(home, moving)).toMatchObject({ k: rawKey, b: join(home, "projects", rawKey) });
    // the collision: both files where they were (nothing had moved)
    expect(readFileSync(join(home, "projects", rawKey, `${COLLIDING}.jsonl`), "utf8")).toContain("c-old");
    expect(readFileSync(join(home, "projects", canonKey, `${COLLIDING}.jsonl`), "utf8")).toContain("c-new");
    expect(row(home, colliding).k).toBe(rawKey);
  });

  test("a crash mid-step: an intent recorded before the move is finished on resume, never claimed twice", async () => {
    const { home, moving, rawKey, canonKey } = symlinkedFixture();
    const m1 = await runMigrationC(home, deps());   // phase 1 only (the official working copy waits for a door)
    expect(m1.status).toBe("phase1-complete");
    // the crash: the intent written and the sidecar moved, then nothing more
    const sdkProjects = join(home, "sdk", "projects");
    mkdirSync(join(sdkProjects, canonKey), { recursive: true });
    renameSync(join(sdkProjects, rawKey, `${BACKEND}.provider-state.jsonl`), join(sdkProjects, canonKey, `${BACKEND}.provider-state.jsonl`));
    const state = migrationCState(home);
    if (state.kind !== "parsed") throw new Error("unreachable");
    writeFileSync(migrationCManifestPath(home), JSON.stringify({ ...state.manifest, rekeyed: [{ sessionId: moving, backendId: BACKEND, from: rawKey, to: canonKey, entries: [BACKEND, `${BACKEND}.provider-state.jsonl`, `${BACKEND}.jsonl`], outcome: "pending" }] }));
    const m2 = await finishMigrationC(home, { log: () => {}, reconcile: stubReconcile().reconcile });
    expect(m2.rekeyed?.filter((e) => e.sessionId === moving)).toEqual([expect.objectContaining({ outcome: "moved" })]);
    expect(existsSync(join(sdkProjects, canonKey, `${BACKEND}.jsonl`))).toBe(true);
    expect(row(home, moving).k).toBe(canonKey);
    await rollbackMigrationC(home, { log: () => {} });
    expect(existsSync(join(home, "projects", rawKey, `${BACKEND}.provider-state.jsonl`))).toBe(true);
    expect(existsSync(join(home, "projects", rawKey, `${BACKEND}.jsonl`))).toBe(true);
  });
});
