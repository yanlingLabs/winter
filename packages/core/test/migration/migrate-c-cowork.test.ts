// Migration C and Cowork storage. docs/cowork-execution-contracts.md, "Host storage authority, fences and
// migration": Migration C never renames or re-keys the Cowork control tree, disk contents, workspace IDs
// or SDK store identities, and live or not-provably-stopped ownership refuses migration. Existing
// coverage (migrate-c.test.ts) pins the runtime-state side (`hostRuntimePredicate`); this file pins the
// filesystem side, the ownership refusal, the manifest-driven paths, and `migrate-project`'s fence.
// Each guard has its own test so that removing it alone fails a test (mutation checked in the PR).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MigrationCRefused, coworkManifestProblem, finishMigrationC, migrationCManifestPath, migrationCPreflightProblem, migrationCState, rollbackMigrationC, runMigrationC, type MigrationCManifest } from "../../src/migration/migrate-c";
import { isCoworkStorageRel } from "../../src/migration/cowork-exclusion";
import { ProjectMigrationRefused, planProjectMigration, runProjectMigration } from "../../src/migration/project-files";
import { SDK_COMPAT_LINKS } from "../../src/agent/paths";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import { registerHostStorageFences } from "../../src/runtime-sdk/host-storage-fence";
import { LEGACY_INSTRUCTIONS_FILE } from "../../src/legacy-names";

const dirs: string[] = [];
const unregister: Array<() => void> = [];
afterEach(() => { unregister.splice(0).forEach(fn => fn()); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tempDir = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };
const write = (p: string, body: string): void => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
const deps = (extra: Record<string, unknown> = {}) => ({ log: () => {}, reconcileAvailable: true, probe: { alive: () => false, startedAt: () => "unknown" }, ...extra });

const WORKSPACE_DIR = "ws_fixture";
/** A home in the old layout (real `skills/` content) plus a Cowork tree whose artifact names collide with
 * names other migration steps treat specially. `official` leaves phase 1 complete but phase 2 pending. */
function oldLayoutHome(opts: { official?: boolean } = {}): string {
  const home = tempDir("winter-migc-cowork-");
  write(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, permissions: { allow: ["Bash(git status)"] } }));
  write(join(home, "skills", "self", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
  write(join(home, "projects", "-key", "s.jsonl"), '{"type":"user","uuid":"u1"}\n');
  for (const d of ["projects", "file-history", "tasks", "teams", "agent-memory", "workflows"]) mkdirSync(join(home, "sdk", d), { recursive: true });
  if (opts.official) write(join(home, "runtimes", "claude-config", "projects", "-key", "s-official.jsonl"), '{"type":"user","uuid":"o1"}\n');
  return home;
}
function coworkTree(home: string): void {
  const base = join(home, "cowork", "workspaces", WORKSPACE_DIR);
  for (const rel of ["data.ext4", "env.ext4", "manifest.json", "shared/instructions/WINTER.md", "shared/memory/notes.md", "shared/outputs/s1/index.db", "shared/outputs/s1/x.db-wal", "shared/outputs/s1/x.db-shm"]) write(join(base, rel), `bytes of ${rel}`);
}
/** Type, size, mtime and content hash of every path beneath `root`. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name), st = lstatSync(abs), rel = relative(root, abs);
      if (/^runtime-state\.db-(shm|wal)$/.test(name)) continue; // SQLite's mapped sidecars change on any open, even a readonly one
      if (st.isDirectory()) { out[rel] = `dir:${st.ino}`; walk(abs); }
      else if (st.isSymbolicLink()) out[rel] = "symlink";
      else out[rel] = `${st.size}:${st.ino}:${st.mtimeMs}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
/** A canonical workspace row (and optionally a recorded writable disk owner). Powers other than
 * `stopped` are written directly: nothing in this build can produce them through a public door. */
function coworkRecords(home: string, power: "stopped" | "running" | "uncertain" = "stopped", owned = false): string {
  const rs = openRuntimeStateDb(home);
  try {
    const repo = new CoworkRepository(rs);
    const created = repo.create({ principalId: "fixture", requestId: "create" }, {
      ownership: "project", title: "migration fixture", sources: [{ kind: "folder", label: "fixture", access: "read-write", detail: { grantRef: "grant_fixture", rootIdentity: "root_fixture" } }],
      ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" },
    });
    const id = created.value.workspace.workspaceId, homeId = repo.homeIdentity();
    rs.db.run("UPDATE cowork_workspaces SET power=? WHERE workspace_id=?", [power, id]);
    if (owned) {
      rs.db.run(`INSERT INTO cowork_volumes(volume_id,home_id,workspace_id,creation_id,purpose,format,format_version,capacity_bytes,sector_bytes,filesystem_block_bytes,state,filesystem_state,device,inode,uid,mode,owner_json,created_at,updated_at)
        VALUES('vol_fixture',?,?,'creation_fixture','data','raw-ext4-v1',1,16777216,512,4096,'allocated','recovery-required','1','2',?,384,?,'t','t')`,
        [homeId, id, process.geteuid!(), JSON.stringify({ controllerInstanceId: "c", workerInstanceId: "w", incarnationId: "i", leaseEpoch: 1, runtimeImageDigest: "a".repeat(64) })]);
    }
    return id;
  } finally { rs.close(); }
}
const count = (home: string, table: string): number => {
  const rs = openRuntimeStateDb(home, { readonly: true });
  try { return rs.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n; } finally { rs.close(); }
};
const refusal = async (run: () => Promise<unknown>): Promise<MigrationCRefused> => {
  try { await run(); } catch (error) { expect(error).toBeInstanceOf(MigrationCRefused); return error as MigrationCRefused; }
  throw new Error("expected a MigrationCRefused");
};

describe("what Migration C moves never names Cowork storage", () => {
  test("the fixed move/link targets are disjoint from the Cowork root", () => {
    for (const [name, target] of SDK_COMPAT_LINKS) {
      expect(isCoworkStorageRel(name)).toBe(false);
      expect(isCoworkStorageRel(target)).toBe(false);
    }
  });
  test("a full run and its rollback leave the whole Cowork tree byte-identical (same inodes, mtimes, bytes)", async () => {
    const home = oldLayoutHome(); coworkTree(home);
    const before = snapshot(join(home, "cowork"));
    expect(Object.keys(before).length).toBeGreaterThan(8);
    const manifest = await runMigrationC(home, deps({ reconcile: async () => "clean" }));
    expect(manifest.status).toBe("complete");
    expect(existsSync(join(home, "sdk", "skills", "self", "deploy", "SKILL.md"))).toBe(true); // it really migrated
    expect(snapshot(join(home, "cowork"))).toEqual(before);
    await rollbackMigrationC(home, { log: () => {} });
    expect(existsSync(join(home, "skills", "self", "deploy", "SKILL.md"))).toBe(true); // and really rolled back
    expect(snapshot(join(home, "cowork"))).toEqual(before);
  });
});

describe("live or not-provably-stopped Cowork ownership refuses the migration (contract: Migration C)", () => {
  for (const power of ["running", "uncertain"] as const) {
    test(`a workspace whose power is ${power} refuses at preflight, before anything moves`, async () => {
      const home = oldLayoutHome(); coworkTree(home); coworkRecords(home, power);
      const before = snapshot(home);
      expect(migrationCPreflightProblem(home, deps())).toContain("not provably stopped");
      const refused = await refusal(() => runMigrationC(home, deps({ reconcile: async () => "clean" })));
      expect(refused.code).toBe("sdk_home_migration_refused");
      expect(refused.message).toContain("not provably stopped");
      // nothing moved: the only difference is the archive directory the refusal removed again (none)
      expect(snapshot(home)).toEqual(before);
      expect(existsSync(migrationCManifestPath(home))).toBe(false);
    });
  }
  test("a stopped workspace that still records a writable disk owner refuses at preflight", async () => {
    const home = oldLayoutHome(); coworkTree(home); coworkRecords(home, "stopped", true);
    expect(migrationCPreflightProblem(home, deps())).toContain("writable disk owner");
    expect((await refusal(() => runMigrationC(home, deps({ reconcile: async () => "clean" })))).code).toBe("sdk_home_migration_refused");
    expect(existsSync(join(home, "sdk", "skills", "self"))).toBe(false);
  });
  test("a stopped, unowned workspace does not block, and its records and files are untouched", async () => {
    const home = oldLayoutHome(); coworkTree(home); const id = coworkRecords(home, "stopped");
    const tree = snapshot(join(home, "cowork"));
    expect(migrationCPreflightProblem(home, deps())).toBeUndefined();
    await runMigrationC(home, deps({ reconcile: async () => "clean" }));
    expect(count(home, "cowork_workspaces")).toBe(1);
    expect(snapshot(join(home, "cowork"))).toEqual(tree);
    const rs = openRuntimeStateDb(home, { readonly: true });
    try { expect(rs.db.query<{ power: string }, [string]>("SELECT power FROM cowork_workspaces WHERE workspace_id=?").get(id)?.power).toBe("stopped"); } finally { rs.close(); }
  });
  test("resuming a phase-1-complete run applies the same refusal", async () => {
    const home = oldLayoutHome({ official: true }); coworkTree(home); const id = coworkRecords(home, "stopped");
    const first = await runMigrationC(home, deps()); // no router door: phase 2 waits
    expect(first.status).toBe("phase1-complete");
    const rs = openRuntimeStateDb(home); rs.db.run("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", [id]); rs.close();
    const tree = snapshot(join(home, "cowork"));
    const refused = await refusal(() => runMigrationC(home, deps({ reconcile: async () => "clean" })));
    expect(refused.code).toBe("sdk_home_migration_refused");
    expect(migrationCState(home).kind === "parsed" && (migrationCState(home) as { manifest: MigrationCManifest }).manifest.status).toBe("phase1-complete");
    expect(snapshot(join(home, "cowork"))).toEqual(tree);
  });
});

describe("a rollback cannot discard Cowork authority", () => {
  test("with populated Cowork records the schema step refuses first: nothing is restored and the tree is untouched", async () => {
    const home = oldLayoutHome(); coworkTree(home); coworkRecords(home, "stopped");
    await runMigrationC(home, deps({ reconcile: async () => "clean" }));
    const before = snapshot(home);
    const refused = await refusal(() => rollbackMigrationC(home, { log: () => {} }));
    expect(refused.code).toBe("sdk_home_migration_refused");
    expect(refused.message).toContain("nothing was restored");
    expect(snapshot(home)).toEqual(before);
    expect(count(home, "cowork_workspaces")).toBe(1);
  });
});

describe("manifest-driven paths: a resumed or rolled-back run never moves Cowork storage", () => {
  const base: MigrationCManifest = { schemaVersion: 1, home: "/h", startedAt: "t", status: "in-progress", archiveDir: "/h/migration/c-t", steps: [], backups: { settings: null, runtimeState: null, sdkSettings: null, sdkGlobal: null, splitMarker: null }, moved: [], links: [], copied: [], archived: [], reconciled: [] };
  test("coworkManifestProblem finds Cowork paths in every path-carrying field, relative or absolute, however spelled", () => {
    expect(coworkManifestProblem(base)).toBeUndefined();
    expect(coworkManifestProblem({ ...base, moved: [{ from: "projects", to: "sdk/projects" }], links: ["projects"], copied: ["sdk/history.jsonl"], archived: [{ from: "runtimes/claude-config", to: "migration/c-t/claude-config" }] })).toBeUndefined();
    for (const bad of [
      { moved: [{ from: "cowork/workspaces/w/data.ext4", to: "sdk/x" }] }, { moved: [{ from: "projects", to: "cowork/workspaces/w" }] },
      { displaced: [{ from: "cowork/x", to: "migration/y" }] }, { moving: { from: "skills", to: "./cowork/x" } },
      { links: ["cowork"] }, { copied: ["a/../cowork/x"] }, { archived: [{ from: "/h/cowork/workspaces/w/env.ext4", to: "migration/x" }] },
      // rollback renames INTO `<archiveDir>/rolled-back/...`, and the re-key step joins keys and names under sdk/projects
      { archiveDir: "cowork/x" }, { archiveDir: "/h/cowork/workspaces/w/archive" },
      { backups: { ...base.backups, settings: "/h/cowork/workspaces/w/settings.json.bak" } },
      { reconciled: [{ root: "/h/cowork/workspaces/w", outcome: "clean" as const }] },
      { rekeyed: [{ sessionId: "s", backendId: "b", from: "-raw", to: "../../cowork/workspaces/w", entries: ["b.jsonl"], outcome: "moved" as const }] },
      { rekeyed: [{ sessionId: "s", backendId: "b", from: "-raw", to: "-canon", entries: ["../../../cowork/workspaces/w/data.ext4"], outcome: "pending" as const }] },
    ]) expect(coworkManifestProblem({ ...base, ...bad } as MigrationCManifest)).toContain("Cowork storage");
    // a path that leaves the home is refused too, Cowork or not
    for (const bad of [{ moved: [{ from: "projects", to: "../elsewhere" }] }, { archiveDir: "/elsewhere/c-t" }, { rekeyed: [{ sessionId: "s", backendId: "b", from: "-raw", to: "../../..", entries: [], outcome: "moved" as const }] }]) {
      expect(coworkManifestProblem({ ...base, ...bad } as MigrationCManifest)).toContain("outside the home");
    }
    // ordinary recorded manifests stay accepted: transcript keys, names, backups inside the archive
    expect(coworkManifestProblem({ ...base, backups: { ...base.backups, runtimeState: "/h/migration/c-t/runtime-state.db" }, reconciled: [{ root: "/h/runtimes/claude-config", outcome: "clean" as const }],
      rekeyed: [{ sessionId: "s", backendId: "b", from: "-Users-x-app", to: "-private-tmp-app", entries: ["b", "b.jsonl"], outcome: "moved" as const }] })).toBeUndefined();
    expect(coworkManifestProblem({ ...base, moved: [{ from: "coworker", to: "sdk/coworker" }] })).toBeUndefined();
  });
  // A lexical `cowork/` prefix check was bypassed by a symlinked parent and, on a case-insensitive volume, by `COWORK/`.
  const linked = (home: string) => symlinkSync(join(home, "cowork", "workspaces", WORKSPACE_DIR), join(home, "innocent"));
  test("coworkManifestProblem judges where paths really live: a symlinked parent or a COWORK/ spelling is Cowork storage in every field; lookalikes are not", () => {
    const home = oldLayoutHome(); coworkTree(home); linked(home);
    mkdirSync(join(home, "sdk", "projects"), { recursive: true }); symlinkSync(join(home, "cowork", "workspaces", WORKSPACE_DIR), join(home, "sdk", "projects", "-evil"));
    const m = { ...base, home, archiveDir: join(home, "migration", "c-t") }, via = "innocent/data.ext4";
    for (const bad of [
      { moved: [{ from: via, to: "sdk/x" }] }, { moved: [{ from: "projects", to: "innocent/y" }] }, { displaced: [{ from: via, to: "migration/y" }] },
      { moving: { from: "skills", to: "innocent/z" } }, { links: ["innocent"] }, { copied: [via] }, { archived: [{ from: "runtimes/claude-config", to: via }] },
      { archiveDir: join(home, "innocent", "archive") }, { backups: { ...base.backups, settings: join(home, "innocent", "settings.json.bak") } },
      { reconciled: [{ root: join(home, "innocent"), outcome: "clean" as const }] },
      { rekeyed: [{ sessionId: "s", backendId: "b", from: "-raw", to: "-evil", entries: [], outcome: "moved" as const }] },
      { moved: [{ from: "COWORK/workspaces/ws_fixture/data.ext4", to: "sdk/x" }] }, { copied: ["Cowork/x"] }, { links: ["COWORK"] },
      { archiveDir: join(home, "COWORK", "archive") },
      // `..` after a symlinked parent: path.join would collapse `innocent/..`, the kernel applies it to the symlink's target
      // (`innocent` -> cowork/workspaces/ws_fixture, so `innocent/../ws2` is the Cowork sibling cowork/workspaces/ws2).
      { archiveDir: `${home}/innocent/../ws2/archive` }, { reconciled: [{ root: `${home}/innocent/../ws2`, outcome: "clean" as const }] },
      { backups: { ...base.backups, settings: `${home}/innocent/../ws2/settings.json.bak` } }, { moved: [{ from: "innocent/../ws2/data.ext4", to: "sdk/x" }] },
      { copied: ["innocent/../ws2/x"] }, { links: ["innocent/../ws2"] }, { archived: [{ from: "runtimes/claude-config", to: "innocent/../ws2/y" }] },
      { rekeyed: [{ sessionId: "s", backendId: "b", from: "-raw", to: "-evil/../../../innocent/../ws2", entries: [], outcome: "moved" as const }] },
    ]) expect(coworkManifestProblem({ ...m, ...bad } as MigrationCManifest)).toContain("Cowork storage");
    // A home whose directory is stored as COWORK (no `cowork` exists), so the spelling alone has to decide on any volume.
    const upper = realpathSync(tempDir("winter-migc-upper-")); mkdirSync(join(upper, "COWORK", "workspaces", "w"), { recursive: true });
    expect(coworkManifestProblem({ ...base, home: upper, archiveDir: join(upper, "migration", "c-t"), moved: [{ from: "COWORK/workspaces/w/data.ext4", to: "sdk/x" }] })).toContain("Cowork storage");
    mkdirSync(join(home, "memory", "cowork"), { recursive: true }); mkdirSync(join(home, "coworker"), { recursive: true });
    // `..` that really stays outside Cowork is still allowed, by the lexical reading and by the kernel's
    for (const ok of ["cowork/../sessions/x", "sessions/./s1/../s1/a.jsonl", "memory/cowork/../notes.md"]) {
      expect(coworkManifestProblem({ ...m, moved: [{ from: ok, to: "sdk/elsewhere" }], copied: [ok] } as MigrationCManifest)).toBeUndefined();
    }
    expect(coworkManifestProblem({ ...m, archiveDir: `${home}/cowork/../migration/c-t`, backups: { ...base.backups, settings: `${home}/cowork/../settings.json.bak` } } as MigrationCManifest)).toBeUndefined();
    for (const ok of ["sessions/x", "coworker/x", "memory/cowork/notes.md", "sdk/cowork", "cowork.txt", "skills", "sdk/skills"]) {
      expect(coworkManifestProblem({ ...m, moved: [{ from: ok, to: "sdk/elsewhere" }], links: [ok], copied: [ok] } as MigrationCManifest)).toBeUndefined();
    }
  });
  const behindLink = (extra: Partial<MigrationCManifest> = {}) => (h: string): Partial<MigrationCManifest> => {
    linked(h);
    return { moved: [{ from: "skills", to: "sdk/skills" }, { from: "innocent/data.ext4", to: "sdk/stolen" }], ...extra };
  };
  const spelled = { moved: [{ from: "skills", to: "sdk/skills" }, { from: "COWORK/workspaces/ws_fixture/data.ext4", to: "sdk/stolen" }] };
  const dotdot = (h: string): Partial<MigrationCManifest> => { linked(h); return { moved: [{ from: "skills", to: "sdk/skills" }, { from: "innocent/../ws2/data.ext4", to: "sdk/stolen" }] }; };
  for (const [name, patch] of [["a symlinked parent", behindLink()], ["`..` after a symlinked parent", dotdot], ["a COWORK/ spelling", spelled], ["an archive directory behind a symlink", (h: string) => { linked(h); return { archiveDir: join(h, "innocent", "archive") }; }]] as const) {
    test(`resume, phase 2 and rollback all refuse a manifest that reaches Cowork storage through ${name}; nothing moves`, async () => {
      const resume = await tamper(patch, "in-progress");
      const r1 = await refusal(() => runMigrationC(resume.home, deps({ reconcile: async () => "clean" })));
      expect(r1.code).toBe("sdk_home_half_migrated"); expect(r1.message).toContain("Cowork storage");
      expect(snapshot(resume.home)).toEqual(resume.whole);
      const phase2 = await tamper(patch, "phase1-complete");
      expect((await refusal(() => finishMigrationC(phase2.home, { log: () => {}, reconcile: async () => "clean" }))).code).toBe("sdk_home_half_migrated");
      expect(snapshot(phase2.home)).toEqual(phase2.whole);
      const back = await tamper(patch, "complete");
      const r3 = await refusal(() => rollbackMigrationC(back.home, { log: () => {} }));
      expect(r3.code).toBe("sdk_home_migration_refused"); expect(r3.message).toContain("nothing was restored");
      expect(snapshot(back.home)).toEqual(back.whole);
      expect(readFileSync(join(back.home, "cowork", "workspaces", WORKSPACE_DIR, "data.ext4"), "utf8")).toBe("bytes of data.ext4");
    });
  }
  const tamper = async (patch: Partial<MigrationCManifest> | ((home: string) => Partial<MigrationCManifest>), status: MigrationCManifest["status"]) => {
    const home = oldLayoutHome({ official: true }); coworkTree(home);
    await runMigrationC(home, deps()); // phase 1 complete; phase 2 pending
    const state = migrationCState(home) as { kind: "parsed"; manifest: MigrationCManifest };
    writeFileSync(migrationCManifestPath(home), `${JSON.stringify({ ...state.manifest, ...(typeof patch === "function" ? patch(home) : patch), status }, null, 2)}\n`);
    return { home, tree: snapshot(join(home, "cowork")), whole: snapshot(home) };
  };
  const named = { moved: [{ from: "skills", to: "sdk/skills" }, { from: "cowork/workspaces/ws_fixture", to: "sdk/stolen" }] };
  test("resume refuses a manifest that names Cowork storage; nothing moves", async () => {
    const { home, whole } = await tamper(named, "in-progress");
    const refused = await refusal(() => runMigrationC(home, deps({ reconcile: async () => "clean" })));
    expect(refused.code).toBe("sdk_home_half_migrated"); expect(refused.message).toContain("Cowork storage");
    expect(snapshot(home)).toEqual(whole);
  });
  test("phase 2 refuses it too", async () => {
    const { home, whole } = await tamper(named, "phase1-complete");
    const refused = await refusal(() => finishMigrationC(home, { log: () => {}, reconcile: async () => "clean" }));
    expect(refused.code).toBe("sdk_home_half_migrated");
    expect(snapshot(home)).toEqual(whole);
  });
  test("a tampered archive directory — the target of rollback's renames — is refused before anything is restored", async () => {
    const { home, whole } = await tamper(h => ({ archiveDir: join(h, "cowork", "workspaces", WORKSPACE_DIR, "archive") }), "complete");
    const refused = await refusal(() => rollbackMigrationC(home, { log: () => {} }));
    expect(refused.code).toBe("sdk_home_migration_refused"); expect(refused.message).toContain("nothing was restored");
    expect(snapshot(home)).toEqual(whole);
  });
  test("rollback refuses it before restoring anything", async () => {
    const { home, whole } = await tamper(named, "complete");
    const refused = await refusal(() => rollbackMigrationC(home, { log: () => {} }));
    expect(refused.code).toBe("sdk_home_migration_refused"); expect(refused.message).toContain("nothing was restored");
    expect(snapshot(home)).toEqual(whole);
  });
});

describe("migrate-project cannot rename or rewrite Cowork backing storage", () => {
  test("a project directory inside a registered Cowork root is refused at plan and at execution; nothing is renamed", () => {
    const home = tempDir("winter-migp-home-"), coordination = tempDir("winter-migp-coord-");
    const project = join(home, "cowork", "workspaces", WORKSPACE_DIR, "shared", "outputs", "s1");
    write(join(project, LEGACY_INSTRUCTIONS_FILE), "# legacy instructions\n");
    unregister.push(registerHostStorageFences(home, { coordinationDir: coordination, coworkStorageActive: true }));
    const thrown = (fn: () => unknown): ProjectMigrationRefused => { try { fn(); } catch (error) { expect(error).toBeInstanceOf(ProjectMigrationRefused); return error as ProjectMigrationRefused; } throw new Error("expected a refusal"); };
    expect(thrown(() => planProjectMigration(project, { winterHome: home })).code).toBe("control_storage");
    // A plan prepared elsewhere and re-pointed at Cowork storage is rechecked at execution.
    const elsewhere = tempDir("winter-migp-other-"); write(join(elsewhere, LEGACY_INSTRUCTIONS_FILE), "# other\n");
    const plan = planProjectMigration(elsewhere, { winterHome: home });
    const redirected = { ...plan, dir: project, steps: plan.steps.map(step => ({ ...step, from: join(project, LEGACY_INSTRUCTIONS_FILE), to: join(project, "WINTER.md") })) };
    expect(thrown(() => runProjectMigration(redirected)).code).toBe("control_storage");
    expect(existsSync(join(project, LEGACY_INSTRUCTIONS_FILE))).toBe(true);
    expect(existsSync(join(project, "WINTER.md"))).toBe(false);
  });
});
