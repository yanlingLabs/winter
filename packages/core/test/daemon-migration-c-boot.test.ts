// WS-21 L3.7 (spec §8): Migration C's boot hook, on a build whose router applies run homes (pinned with
// `setRunHomeSupportForTests(true)` — router 0.0.11 does not, and there the old layout IS the layout).
//
//   the profile's default home in the old layout → phase 1 runs at boot, phase 2 at the late site
//   a preflight refusal on the default home        → boot refuses, typed (never log-and-continue)
//   any other home in the old layout               → boot refuses `sdk_home_migration_required`
//   a half-migrated home                           → boot refuses `sdk_home_half_migrated` (every build)
//   a fresh temp home seeded with settings         → boots; the settings split copies the moved keys
//
// Every home is a mkdtemp; the default-home gate is driven by `homedirOverride` (P9c-15), never the real ~.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { SessionStore } from "../src/sessions/store";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { setRunHomeSupportForTests } from "../src/runtime-sdk/run-home-support";
import { MigrationCRefused, migrationCCompletePath, migrationCManifestPath, migrationCState, runMigrationC } from "../src/migration/migrate-c";
import { openRuntimeStateDb } from "../src/runtime-state/db";
import { readSdkSettings } from "../src/sdk-files";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  setRunHomeSupportForTests(undefined);
});

const parentDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "winter-migc-boot-")));

function seedOldLayout(home: string): void {
  mkdirSync(join(home, "projects", "-Users-x-app", "memory"), { recursive: true });
  writeFileSync(join(home, "projects", "-Users-x-app", "s1.jsonl"), '{"type":"user","uuid":"u1"}\n');
  writeFileSync(join(home, "projects", "-Users-x-app", "memory", "MEMORY.md"), "- a fact\n");
  mkdirSync(join(home, "skills", "self", "deploy"), { recursive: true });
  writeFileSync(join(home, "skills", "self", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, outputStyle: "terse" }));
}

async function boot(home: string, parent: string): Promise<RunningDaemon> {
  return startDaemon({
    home,
    secrets: new FileSecretStore(join(parent, "secrets")),
    migration: { legacyHome: join(parent, "no-legacy-home"), homedirOverride: () => parent },
    agentProvider: null,
  });
}

describe("Migration C at boot (run-home router)", () => {
  test("the default home in the old layout migrates: phase 1 at boot, phase 2 at the late site, then boots", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, ".winter");
    seedOldLayout(home);
    daemon = await boot(home, parent);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "sdk", "projects", "-Users-x-app", "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(home, "sdk", "skills", "self", "deploy", "SKILL.md"))).toBe(true);
    // no official working copy to reconcile, so phase 2 completed at this very boot
    expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "complete" } });
    expect(existsSync(migrationCCompletePath(home))).toBe(true);
    expect((readSdkSettings(home) as Record<string, unknown>).outputStyle).toBe("terse");
    expect(daemon.settings()).not.toBeNull();
  });

  test("a preflight refusal on the default home refuses BOOT, typed, and moves nothing", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, ".winter");
    seedOldLayout(home);
    mkdirSync(join(home, "sdk", "projects"), { recursive: true });
    writeFileSync(join(home, "sdk", "projects", "stray.jsonl"), "x"); // sdk/ already has content
    let caught: unknown;
    try { daemon = await boot(home, parent); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MigrationCRefused);
    expect((caught as MigrationCRefused).code).toBe("sdk_home_migration_refused");
    expect(lstatSync(join(home, "projects")).isDirectory()).toBe(true);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(false);
  });

  test("a non-default home in the old layout refuses sdk_home_migration_required", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, "custom-home");
    seedOldLayout(home);
    let caught: unknown;
    try { daemon = await boot(home, parent); } catch (err) { caught = err; }
    expect((caught as MigrationCRefused).code).toBe("sdk_home_migration_required");
    expect((caught as Error).message).toContain("winter migrate --sdk-home --home");
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(false);
  });

  test("a half-migrated home refuses sdk_home_half_migrated, whatever the router", async () => {
    const parent = parentDir();
    const home = join(parent, "half");
    mkdirSync(join(home, "migration", "c"), { recursive: true });
    writeFileSync(join(home, "migration", "c", "manifest.json"), JSON.stringify({ schemaVersion: 1, status: "in-progress", steps: [] }));
    let caught: unknown;
    try { daemon = await boot(home, parent); } catch (err) { caught = err; }
    expect((caught as MigrationCRefused).code).toBe("sdk_home_half_migrated");
  });

  test("a fresh temp home seeded with settings boots, and the split copies the moved keys", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, "fresh");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, permissions: { allow: ["Bash(ls)"] }, mcpServers: { a: { type: "stdio", command: "x" } } }));
    daemon = await boot(home, parent);
    expect(migrationCState(home).kind).toBe("absent");
    expect((readSdkSettings(home) as Record<string, any>).permissions.allow).toEqual(["Bash(ls)"]);
  });

  test("the dev profile's default home (~/.winter-dev, by homedirOverride) migrates the same way", async () => {
    setRunHomeSupportForTests(true);
    const prior = process.env.WINTER_PROFILE;
    process.env.WINTER_PROFILE = "dev";
    try {
      const parent = parentDir();
      const home = join(parent, ".winter-dev");
      seedOldLayout(home);
      daemon = await boot(home, parent);
      expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(true);
      expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "complete" } });
    } finally {
      if (prior === undefined) delete process.env.WINTER_PROFILE; else process.env.WINTER_PROFILE = prior;
    }
  });

  // Review: the two-phase ordering — no session can open while the manifest says `phase1-complete`.
  test("a home left phase1-complete whose phase 2 cannot finish refuses BOOT (no socket, no session), and says why", async () => {
    setRunHomeSupportForTests(true);
    const parent = parentDir();
    const home = join(parent, ".winter");
    seedOldLayout(home);
    mkdirSync(join(home, "runtimes", "claude-config", "projects", "-Users-x-app"), { recursive: true });
    writeFileSync(join(home, "runtimes", "claude-config", "projects", "-Users-x-app", "s-official.jsonl"), '{"type":"user"}\n');
    // phase 1 ran (the CLI, say); phase 2 then cannot finish. R.1: this rested on router 0.0.11 having no
    // reconcile door; the linked router has one, and a reconcile that FAILS is absorbed by design (the root is
    // archived and its sessions marked repair-required — L3 round 3, minor 7). What still stops phase 2 is a
    // fault in phase 2 itself: here its manifest directory cannot be written, so no step can be recorded.
    const m = await runMigrationC(home, { log: () => {}, reconcileAvailable: true, probe: { alive: () => false, startedAt: () => "unknown" } });
    expect(m.status).toBe("phase1-complete");
    const manifestDir = dirname(migrationCManifestPath(home));
    chmodSync(manifestDir, 0o500);
    try {
      for (let attempt = 0; attempt < 2; attempt++) { // the lock was released: a retry refuses the same way
        let caught: unknown;
        try { daemon = await boot(home, parent); } catch (err) { caught = err; }
        expect((caught as MigrationCRefused).code).toBe("sdk_home_migration_refused");
        expect((caught as Error).message).toContain("no session opens");
        expect(existsSync(join(home, "run", "core.sock"))).toBe(false);
      }
    } finally { chmodSync(manifestDir, 0o700); }
    expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "phase1-complete" } });
  });

  // Router review of I6 — the ORDERING CONTRACT: a `canonical-ahead` verdict clears a session's repair flag,
  // which is only safe while no live session with that key exists, so the ordinary boot sweep of
  // `cache/runs/*` must finish before the first session can open (no socket before it is done).
  test("the boot sweep of cache/runs/* completes before the socket exists (no session can open during it)", async () => {
    const parent = parentDir();
    const home = join(parent, "sweep");
    mkdirSync(join(home, "cache", "runs", "r1", "projects", "k"), { recursive: true });
    writeFileSync(join(home, "cache", "runs", "r1", "projects", "k", "s.jsonl"), '{"type":"user"}\n');
    const calls: Array<{ root: string; socketExisted: boolean }> = [];
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(parent, "secrets")), agentProvider: null,
      migration: { legacyHome: join(parent, "no-legacy-home"), homedirOverride: () => parent },
      runRootReconcileForTests: async (root) => {
        calls.push({ root, socketExisted: existsSync(join(home, "run", "core.sock")) });
        await Bun.sleep(50); // a slow reconcile: boot still waits for it
        return { outcome: "clean", transcripts: [{ projectKey: "k", sessionId: "be", outcome: "canonical-ahead", appended: 0 }] };
      },
    });
    expect(calls.map((c) => c.root)).toEqual([join(home, "cache", "runs", "r1")]);
    expect(calls.every((c) => !c.socketExisted)).toBe(true);
    expect(existsSync(join(home, "cache", "runs", "r1"))).toBe(false); // finished before startDaemon resolved
    expect(existsSync(join(home, "run", "core.sock"))).toBe(true);
  });

  // Round 4 (Important): the staging-root sweep must run BEFORE phase 2's bulk re-key. A 0.116 official
  // session in a symlinked cwd crashed mid-resume: its staging root holds a tail never mirrored, at the RAW
  // key. Swept after the re-key had moved the canonical file, the router found nothing at the raw key and
  // appended the whole copy into a new orphan there ("appended": nothing marked) — the session then resumed
  // from the canonical key without its tail. The reconcile here emulates the router's: append a working
  // copy's tail to the canonical file at the SAME key when the canonical lines are its prefix.
  const emulatedReconcile = (storeProjects: string) => async (root: string) => {
    const transcripts: { projectKey: string; sessionId: string; outcome: "clean" | "appended" | "canonical-ahead" | "quarantined"; appended: number }[] = [];
    const lines = (p: string): string[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0) : []);
    for (const key of existsSync(join(root, "projects")) ? readdirSync(join(root, "projects")) : []) {
      for (const f of readdirSync(join(root, "projects", key)).filter((n) => n.endsWith(".jsonl"))) {
        const local = lines(join(root, "projects", key, f));
        const canonPath = join(storeProjects, key, f);
        const canon = lines(canonPath);
        const sessionId = f.slice(0, -".jsonl".length);
        if (local.length > canon.length && canon.every((l, i) => l === local[i])) {
          mkdirSync(join(storeProjects, key), { recursive: true });
          appendFileSync(canonPath, local.slice(canon.length).map((l) => `${l}\n`).join(""));
          transcripts.push({ projectKey: key, sessionId, outcome: "appended", appended: local.length - canon.length });
        } else if (local.every((l, i) => l === canon[i])) {
          transcripts.push({ projectKey: key, sessionId, outcome: local.length === canon.length ? "clean" : "canonical-ahead", appended: 0 });
        } else transcripts.push({ projectKey: key, sessionId, outcome: "quarantined", appended: 0 });
      }
    }
    const outcome = transcripts.some((t) => t.outcome === "quarantined") ? "quarantined" as const : transcripts.some((t) => t.outcome === "appended") ? "appended" as const : "clean" as const;
    return { outcome, transcripts };
  };

  for (const spool of [true, false]) test(`round 4: a crashed official resume's staging root is reconciled BEFORE the re-key — its tail reaches the canonical transcript, no orphan (${spool ? "phase 2 at the late site" : "no spool: phase 2 must still wait for the sweep"})`, async () => {
    setRunHomeSupportForTests(true);
    const scanBefore = process.env.WINTER_CLAUDE_RESUME_SCAN_ROOT;
    const scan = realpathSync(mkdtempSync(join(tmpdir(), "winter-r4-scan-")));
    process.env.WINTER_CLAUDE_RESUME_SCAN_ROOT = scan;
    try {
      const parent = parentDir();
      const home = join(parent, ".winter");
      seedOldLayout(home);
      const real = realpathSync(mkdtempSync(join(tmpdir(), "winter-r4-real-")));
      const link = join(parent, "proj-link");
      symlinkSync(real, link);
      const rawKey = transcriptProjectKey(link);
      const canonKey = transcriptProjectKey(real);
      const B = "5f0c2e11-aaaa-4bbb-8ccc-0123456789ab";
      const L1 = '{"type":"user","uuid":"t1"}';
      const L2 = '{"type":"assistant","uuid":"t2-unmirrored"}';
      const store = new SessionStore(home);
      const sid = store.createSession("t", { mode: "code", cwd: link });
      store.close();
      mkdirSync(join(home, "projects", rawKey), { recursive: true });
      writeFileSync(join(home, "projects", rawKey, `${B}.jsonl`), `${L1}\n`);
      // the 0.116 official spool (phase 2 then waits for the late site, as on any home that ran this leg);
      // without one, the boot hook must STILL leave phase 2 to the late site while a staging root exists
      if (spool) {
        mkdirSync(join(home, "runtimes", "claude-config", "projects", rawKey), { recursive: true });
        writeFileSync(join(home, "runtimes", "claude-config", "projects", rawKey, `${B}.jsonl`), `${L1}\n`);
      }
      // the crashed resume: its staging root, named on the session's directory row
      const staging = join(scan, "claude-resume-r4");
      mkdirSync(join(staging, "projects", rawKey), { recursive: true });
      writeFileSync(join(staging, "projects", rawKey, `${B}.jsonl`), `${L1}\n${L2}\n`);
      const rs = openRuntimeStateDb(home);
      rs.db.run(`INSERT INTO runtime_sessions (winter_session_id, runtime_kind, backend_session_id, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
        transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json)
        VALUES (?, 'claude-agent', ?, 'anthropic', 'anthropic/claude-x', ?, ?, ?, ?, 'clean', 'agent-state', 'c1', 'recorded', 't', 't', 'idle', ?)`,
        [sid, B, join(home, "projects", rawKey), rawKey, rawKey, rawKey, JSON.stringify({ runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-x", family: "claude", authFamily: "api-key", reason: "r", decidedAt: "t" })]);
      rs.db.run("INSERT INTO directory_entries (address, entry_json, updated_at) VALUES (?, ?, 't')", [`winter://session/${sid}`, JSON.stringify({ objectKind: "session", configDir: staging })]);
      rs.close();
      daemon = await startDaemon({
        home, secrets: new FileSecretStore(join(parent, "secrets")), agentProvider: null,
        migration: { legacyHome: join(parent, "no-legacy-home"), homedirOverride: () => parent },
        runRootReconcileForTests: emulatedReconcile(join(home, "sdk", "projects")),
      });
      expect(migrationCState(home)).toMatchObject({ kind: "parsed", manifest: { status: "complete" } });
      expect(readFileSync(join(home, "sdk", "projects", canonKey, `${B}.jsonl`), "utf8")).toBe(`${L1}\n${L2}\n`);
      expect(existsSync(join(home, "sdk", "projects", rawKey, `${B}.jsonl`))).toBe(false);   // no orphan
      expect(existsSync(staging)).toBe(false);
    } finally {
      if (scanBefore === undefined) delete process.env.WINTER_CLAUDE_RESUME_SCAN_ROOT; else process.env.WINTER_CLAUDE_RESUME_SCAN_ROOT = scanBefore;
    }
  });

  test("router 0.0.11 (no run homes): the old layout is left exactly as it is", async () => {
    setRunHomeSupportForTests(false);
    const parent = parentDir();
    const home = join(parent, ".winter");
    seedOldLayout(home);
    daemon = await boot(home, parent);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(false);
    expect(migrationCState(home).kind).toBe("absent");
    const rs = openRuntimeStateDb(home);
    rs.close();
  });
});
