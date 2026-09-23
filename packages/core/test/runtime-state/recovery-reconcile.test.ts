// WS-21 L3.6 (spec §3.8, recovery): every recorded local-write root, every leftover run folder under
// `<home>/cache/runs/`, and every stale unclaimed claude staging root is reconciled through the ROUTER's
// `reconcileRootForRecovery` before anything is deleted:
//
//   clean       → deleted
//   appended    → deleted (the router appended the tail to the canonical store first)
//   quarantined → KEPT, recorded in `run_root_quarantine` (never reconciled or swept again) and reported
//
// The real outcomes are the router's (L2.7b, and R.2 on a real binary); here a stub handle answers each.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { quarantinedRunRoots, recoverRunRoots } from "../../src/runtime-state/root-recovery";
import { recoverRuntimeState } from "../../src/runtime-state/recovery";
import { SessionStore } from "../../src/sessions/store";
import { diagnoseRuntimeState } from "../../src/runtime-state/doctor";

type Outcome = "clean" | "appended" | "quarantined";

function world() {
  const home = mkdtempSync(join(tmpdir(), "winter-rrr-home-"));
  const scan = mkdtempSync(join(tmpdir(), "winter-rrr-tmp-"));
  const rs = openRuntimeStateDb(home);
  const runs = join(home, "cache", "runs");
  mkdirSync(runs, { recursive: true });
  const runFolder = (id: string): string => {
    const dir = join(runs, id);
    mkdirSync(join(dir, "projects", "k"), { recursive: true });
    writeFileSync(join(dir, "projects", "k", "s.jsonl"), "{}\n");
    return dir;
  };
  const staging = (name: string, ageHours: number): string => {
    const dir = join(scan, name);
    mkdirSync(join(dir, "projects"), { recursive: true });
    const t = (Date.now() - ageHours * 3600_000) / 1000;
    utimesSync(dir, t, t);
    return dir;
  };
  return { home, scan, rs, runs, runFolder, staging };
}

function stub(outcomes: Record<string, Outcome | "throw">) {
  const seen: string[] = [];
  const reconcile = async (root: string): Promise<Outcome> => {
    seen.push(root);
    const o = outcomes[root] ?? "clean";
    if (o === "throw") throw Object.assign(new Error("link refused"), { code: "run_home_link_refused" });
    return o;
  };
  return { reconcile, seen };
}

function recordRoot(rs: RuntimeStateDb, id: string, root: string, kind: string): void {
  rs.db.run(`INSERT INTO runtime_sessions (winter_session_id, runtime_kind, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
    transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json, active_local_write_root, active_local_write_root_kind)
    VALUES (?, 'claude-agent', 'anthropic', 'anthropic/claude', '/b', 'k', 'k', 'k', 'clean', 'conversation', 'c1', 'recorded', 't', 't', 'idle', '{}', ?, ?)`, [id, root, kind]);
}

describe("recoverRunRoots — the boot sweep of cache/runs/*", () => {
  test("clean → deleted; appended → deleted; quarantined → kept, recorded and reported", async () => {
    const w = world();
    const a = w.runFolder("aaa"), b = w.runFolder("bbb"), c = w.runFolder("ccc");
    const { reconcile, seen } = stub({ [a]: "clean", [b]: "appended", [c]: "quarantined" });
    const report = await recoverRunRoots({ home: w.home, rs: w.rs, reconcile, claudeResumeScanRoot: w.scan });
    expect(seen.sort()).toEqual([a, b, c].sort());
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(true);
    expect(report.runFolders).toMatchObject({ clean: 1, appended: 1, quarantined: 1, failed: 0 });
    expect(report.quarantinedRoots).toEqual([c]);
    expect(quarantinedRunRoots(w.rs).map((q) => q.root)).toEqual([c]);
  });

  test("a quarantined root is kept OUT of every later sweep (never re-reconciled, never re-copied)", async () => {
    const w = world();
    const c = w.runFolder("ccc");
    await recoverRunRoots({ home: w.home, rs: w.rs, reconcile: stub({ [c]: "quarantined" }).reconcile, claudeResumeScanRoot: w.scan });
    const second = stub({});
    const report = await recoverRunRoots({ home: w.home, rs: w.rs, reconcile: second.reconcile, claudeResumeScanRoot: w.scan });
    expect(second.seen).toEqual([]);
    expect(existsSync(c)).toBe(true);
    expect(report.runFolders.skipped).toBe(1);
  });

  test("a reconcile that throws keeps the root and counts it — recovery stays bounded", async () => {
    const w = world();
    const a = w.runFolder("aaa"), b = w.runFolder("bbb");
    const report = await recoverRunRoots({ home: w.home, rs: w.rs, reconcile: stub({ [a]: "throw", [b]: "clean" }).reconcile, claudeResumeScanRoot: w.scan });
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(report.runFolders).toMatchObject({ failed: 1, clean: 1 });
  });

  test("a planted LINK under cache/runs is never reconciled nor followed (it could point at any projects/ tree)", async () => {
    const w = world();
    const elsewhere = mkdtempSync(join(tmpdir(), "winter-rrr-elsewhere-"));
    mkdirSync(join(elsewhere, "projects"), { recursive: true });
    symlinkSync(elsewhere, join(w.runs, "evil"));
    writeFileSync(join(w.runs, "stray.txt"), "x");
    const { reconcile, seen } = stub({});
    const report = await recoverRunRoots({ home: w.home, rs: w.rs, reconcile, claudeResumeScanRoot: w.scan });
    expect(seen).toEqual([]);
    expect(existsSync(join(elsewhere, "projects"))).toBe(true);
    expect(report.runFolders.skipped).toBe(2);
  });

  test("a linked cache (or cache/runs) refuses the whole sweep", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-rrr-linked-"));
    const rs = openRuntimeStateDb(home);
    const elsewhere = mkdtempSync(join(tmpdir(), "winter-rrr-target-"));
    mkdirSync(join(elsewhere, "runs", "x", "projects"), { recursive: true });
    symlinkSync(elsewhere, join(home, "cache"));
    const { reconcile, seen } = stub({});
    const report = await recoverRunRoots({ home, rs, reconcile, claudeResumeScanRoot: mkdtempSync(join(tmpdir(), "winter-rrr-s-")) });
    expect(seen).toEqual([]);
    expect(report.runFolders.refused).toBe(1);
    expect(existsSync(join(elsewhere, "runs", "x"))).toBe(true);
  });

  test("a run folder this process built (live) is left alone", async () => {
    const w = world();
    const a = w.runFolder("live");
    const { reconcile, seen } = stub({});
    await recoverRunRoots({ home: w.home, rs: w.rs, reconcile, isLive: (d) => d === a, claudeResumeScanRoot: w.scan });
    expect(seen).toEqual([]);
    expect(existsSync(a)).toBe(true);
  });
});

describe("recoverRunRoots — recorded local-write roots (step 6)", () => {
  test("a recorded run-folder root: reconciled first; clean → deleted and the column cleared", async () => {
    const w = world();
    const r = w.runFolder("rec");
    recordRoot(w.rs, "s_1", r, "run-folder");
    const { reconcile, seen } = stub({ [r]: "clean" });
    const report = await recoverRunRoots({ home: w.home, rs: w.rs, reconcile, claudeResumeScanRoot: w.scan });
    expect(seen).toEqual([r]); // once — the cache/runs sweep does not see it twice
    expect(existsSync(r)).toBe(false);
    expect(report.recorded).toMatchObject({ clean: 1 });
    expect(w.rs.db.query<{ r: string | null }, []>("SELECT active_local_write_root AS r FROM runtime_sessions").get()!.r).toBeNull();
  });

  test("a recorded root that quarantines marks the session repair-required and is kept", async () => {
    const w = world();
    const r = w.runFolder("rec");
    recordRoot(w.rs, "s_1", r, "run-folder");
    await recoverRunRoots({ home: w.home, rs: w.rs, reconcile: stub({ [r]: "quarantined" }).reconcile, claudeResumeScanRoot: w.scan });
    expect(existsSync(r)).toBe(true);
    expect(w.rs.db.query<{ h: string }, []>("SELECT transcript_health AS h FROM runtime_sessions").get()!.h).toBe("repair-required");
  });

  test("a recorded official-spool root is reconciled but never deleted (not a run folder)", async () => {
    const w = world();
    const spool = mkdtempSync(join(tmpdir(), "winter-rrr-spool-"));
    recordRoot(w.rs, "s_1", spool, "official-spool");
    const { reconcile, seen } = stub({ [spool]: "clean" });
    await recoverRunRoots({ home: w.home, rs: w.rs, reconcile, claudeResumeScanRoot: w.scan });
    expect(seen).toEqual([spool]);
    expect(existsSync(spool)).toBe(true);
  });
});

describe("recoverRunRoots — the claude staging sweep runs only after the reconcile", () => {
  test("stale + unclaimed: clean → deleted, quarantined → kept; fresh ones are never touched", async () => {
    const w = world();
    const oldClean = w.staging("claude-resume-old1", 30);
    const oldQ = w.staging("claude-resume-old2", 30);
    const fresh = w.staging("claude-resume-new", 1);
    const other = w.staging("not-ours", 30);
    const { reconcile, seen } = stub({ [oldClean]: "clean", [oldQ]: "quarantined" });
    const report = await recoverRunRoots({ home: w.home, rs: w.rs, reconcile, claudeResumeScanRoot: w.scan });
    expect(seen.sort()).toEqual([oldClean, oldQ].sort());
    expect(existsSync(oldClean)).toBe(false);
    expect(existsSync(oldQ)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(report.staging).toMatchObject({ removed: 1, quarantined: 1 });
  });
});

describe("recoverRuntimeState — step 8 defers the staging sweep when the router reconciles", () => {
  test("deferClaudeResumeSweep: step 8 deletes nothing and says so; otherwise today's sweep", async () => {
    const w = world();
    const old = w.staging("claude-resume-x", 30);
    const store = new SessionStore(w.home);
    const self = { pid: process.pid, startedAt: new Date().toISOString() };
    const r1 = await recoverRuntimeState({ home: w.home, rs: w.rs, store, self: self as never, tempScanRoot: w.scan, claudeResumeScanRoot: w.scan, deferClaudeResumeSweep: true });
    expect(existsSync(old)).toBe(true);
    expect(r1.steps.find((s) => s.step === 8)!.detail.claudeResumeSweep).toBe("deferred");
    expect(r1.step6AttemptId).toBeDefined();
    const r2 = await recoverRuntimeState({ home: w.home, rs: w.rs, store, self: self as never, tempScanRoot: w.scan, claudeResumeScanRoot: w.scan });
    expect(existsSync(old)).toBe(false);
    expect(r2.steps.find((s) => s.step === 8)!.detail.claudeResumeRemoved).toBe(1);
    store.close();
  });

  test("doctor reads the quarantined roots", async () => {
    const w = world();
    const c = w.runFolder("q");
    await recoverRunRoots({ home: w.home, rs: w.rs, reconcile: stub({ [c]: "quarantined" }).reconcile, claudeResumeScanRoot: w.scan });
    expect(quarantinedRunRoots(w.rs)).toEqual([expect.objectContaining({ root: c })]);
    const findings = await diagnoseRuntimeState(w.home);
    const f = findings.find((x) => x.kind === "run-roots-quarantined");
    expect(f?.detail).toContain(c);
    expect(f?.repairable).toEqual([]);
  });
});
