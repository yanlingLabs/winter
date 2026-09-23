// WS-21 L3.7 (spec §8): Migration C on a fixture home in the old layout — a Winter-leg session, an
// official-leg session whose `claude-config` working copy holds one extra trailing entry, a subagent,
// memory, provider-state, the moved settings keys, and a DeepSeek tag in provider.model, pins and
// selection_json. The router's reconcile is a stub here (its real outcomes are L2's, proven at R.2).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MigrationCRefused, finishMigrationC, isOldLayout, migrationCCompletePath, migrationCManifestPath, migrationCState,
  planMigrationC, rollbackMigrationC, runMigrationC,
} from "../../src/migration/migrate-c";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords } from "../../src/runtime-state/records";
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

  test("without a reconcile door, an official working copy with content refuses the whole migration", async () => {
    const { home } = fixture();
    await expect(runMigrationC(home, deps({ reconcileAvailable: false }))).rejects.toMatchObject({ code: "sdk_home_migration_refused" });
    const empty = fixture({ officialExtra: false });
    expect((await runMigrationC(empty.home, deps({ reconcileAvailable: false }))).status).toBe("phase1-complete");
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
    const m2 = await finishMigrationC(home, { log: () => {}, reconcile: stubReconcile().reconcile });
    expect(m2.status).toBe("complete");
  });

  test("a quarantined or failed official root is still archived (a move — nothing is lost)", async () => {
    const { home } = fixture();
    const root = join(home, "runtimes", "claude-config");
    const m = await runMigrationC(home, deps({ reconcile: async () => { throw new Error("run_home_link_refused"); } }));
    expect(m.reconciled).toEqual([{ root, outcome: "failed" }]);
    expect(existsSync(join(m.archiveDir, "archive", "runtimes", "claude-config", "projects"))).toBe(true);
  });
});

describe("rollback", () => {
  test("restores everything except the step-2 appends; a rolled-back home is the old layout again", async () => {
    const { home, key } = fixture();
    const settingsBefore = readFileSync(join(home, "settings.json"), "utf8");
    await runMigrationC(home, deps({ reconcile: stubReconcile().reconcile }));
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
    expect(existsSync(join(home, "sdk", "settings.json"))).toBe(false);
    expect(existsSync(join(home, "sdk", "projects"))).toBe(true); // bootstrap's placeholder
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(settingsBefore);
    // runtime-state restored from the preflight backup
    const rs = openRuntimeStateDb(home);
    expect(rs.db.query<{ b: string }, []>("SELECT backend_root AS b FROM runtime_sessions WHERE winter_session_id='s_1'").get()!.b).toBe(join(home, "projects", key));
    rs.close();
    expect(isOldLayout(home)).toBe(true);
    expect(existsSync(migrationCManifestPath(home))).toBe(false);
    await expect(rollbackMigrationC(home, { log: () => {} })).rejects.toMatchObject({ code: "nothing_to_rollback" });
  });
});
