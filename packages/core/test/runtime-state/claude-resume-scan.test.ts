// 2026-10-10: the daemon listed the whole per-user temp folder (`os.tmpdir()`) at EVERY boot, looking for
// stale `claude-resume-*` staging roots the retired official leg used to leave — 6.4 s on a folder with
// ~878,000 entries, on the user's real daemon too. The listing now runs at most once per home and scan
// root (`<home>/migration/claude-resume-scan.json`), bounded; later boots take only the roots a directory
// row names and the marker's `pending` paths, BY PATH. Known/quarantined roots stay protected exactly as
// before. These tests prove it with an injected lister (a readdir spy) and with real directories.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeResumeScanMarkerPath,
  claudeResumeStagingPresent,
  listClaudeResumeStaging,
  readClaudeResumeScanMarker,
  recordClaudeResumeScan,
  type ClaudeResumeListing,
  type ClaudeResumeLister,
} from "../../src/runtime-state/claude-resume-scan";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { processStartedAt } from "../../src/runtime-state/leases";
import { quarantinedRunRoots, recoverRunRoots } from "../../src/runtime-state/root-recovery";
import { recoverRuntimeState } from "../../src/runtime-state/recovery";
import { startRuntimeState, runtimeStateOnline } from "../../src/runtime-state/wiring";
import { SessionStore } from "../../src/sessions/store";
import { Settings } from "../../src/settings";
import { withTempHome } from "./support";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A lister that counts its calls and answers with the real one (so the directory is really read). */
function spyLister(): { lister: ClaudeResumeLister; calls: string[] } {
  const calls: string[] = [];
  return { calls, lister: (root) => { calls.push(root); return listClaudeResumeStaging(root); } };
}

function plant(root: string, name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "projects"), { recursive: true });
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

const SELF = () => ({ pid: process.pid, startedAt: processStartedAt(process.pid) });

async function withWorld(fn: (w: { home: string; scan: string; rs: RuntimeStateDb; store: SessionStore }) => Promise<void>): Promise<void> {
  await withTempHome(async (home) => {
    const scan = mkdtempSync(join(tmpdir(), "winter-crs-scan-"));
    const rs = openRuntimeStateDb(home);
    const store = new SessionStore(home);
    try { await fn({ home, scan, rs, store }); } finally { store.close(); rs.close(); }
  });
}

const stub = (outcomes: Record<string, "clean" | "appended" | "quarantined" | "throw"> = {}) => {
  const seen: string[] = [];
  return {
    seen,
    reconcile: async (root: string) => {
      seen.push(root);
      const o = outcomes[root] ?? "clean";
      if (o === "throw") throw new Error("refused");
      return o;
    },
  };
};

describe("listClaudeResumeStaging — bounded, names and entry types only", () => {
  test("finds claude-resume-* DIRECTORIES only (a file or a look-alike is not one)", () => {
    const root = mkdtempSync(join(tmpdir(), "winter-crs-list-"));
    mkdirSync(join(root, "claude-resume-aaa"));
    mkdirSync(join(root, "claude-resume-bbb"));
    writeFileSync(join(root, "claude-resume-file"), "x");
    mkdirSync(join(root, "not-claude-resume-ccc"));
    const listing = listClaudeResumeStaging(root);
    expect(listing.names.sort()).toEqual(["claude-resume-aaa", "claude-resume-bbb"]);
    expect(listing).toMatchObject({ entries: 4, complete: true, absent: false });
  });

  test("an absent root is `absent` (nothing to sweep), any other open error propagates", () => {
    expect(listClaudeResumeStaging(join(tmpdir(), "winter-crs-does-not-exist-xyz"))).toMatchObject({ names: [], absent: true, complete: true });
    expect(() => listClaudeResumeStaging("/x", { open: (() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as never })).toThrow("denied");
  });

  test("the entry cap and the time budget cut a runaway folder short and say so", () => {
    const fake = (n: number) => {
      let i = 0;
      return (() => ({
        readSync: () => (i < n ? { name: `entry-${i++}`, isDirectory: () => false } : null),
        closeSync: () => {},
      })) as never;
    };
    const byEntries = listClaudeResumeStaging("/fake", { open: fake(100_000), maxEntries: 4096 });
    expect(byEntries.complete).toBe(false);
    expect(byEntries.entries).toBeLessThan(10_000);
    let clock = 0;
    const byTime = listClaudeResumeStaging("/fake", { open: fake(1_000_000), budgetMs: 50, now: () => (clock += 10) });
    expect(byTime.complete).toBe(false);
    expect(byTime.entries).toBeLessThan(50_000);
    expect(listClaudeResumeStaging("/fake", { open: fake(3000) })).toMatchObject({ complete: true, entries: 3000 });
  });
});

describe("the marker", () => {
  test("round-trips, is 0600, remembers several roots, and an unknown schema reads as 'not scanned'", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-crs-marker-"));
    expect(readClaudeResumeScanMarker(home)).toBeUndefined();
    expect(recordClaudeResumeScan(home, "/r/one", { complete: true, entries: 7, found: 1, pending: ["/r/one/claude-resume-x"] })).toBe(true);
    expect(recordClaudeResumeScan(home, "/r/two", { complete: false, entries: 9, found: 0, pending: [] })).toBe(true);
    const marker = readClaudeResumeScanMarker(home)!;
    expect(marker.roots).toEqual(["/r/one", "/r/two"]);
    expect(marker.complete).toBe(false);
    expect(marker.pending).toEqual(["/r/one/claude-resume-x"]); // another root's pending survives a later root's record
    expect(statSync(claudeResumeScanMarkerPath(home)).mode & 0o777).toBe(0o600);
    writeFileSync(claudeResumeScanMarkerPath(home), JSON.stringify({ schema: 2, roots: ["/r/one"] }));
    expect(readClaudeResumeScanMarker(home)).toBeUndefined();
    writeFileSync(claudeResumeScanMarkerPath(home), "{not json");
    expect(readClaudeResumeScanMarker(home)).toBeUndefined();
  });
});

describe("recovery step 8 — the staging sweep lists the temp root once per home", () => {
  test("the first boot lists and sweeps and records the marker; a later boot lists NOTHING and sweeps nothing new", async () => {
    await withWorld(async ({ home, scan, rs, store }) => {
      const spy = spyLister();
      const first = plant(scan, "claude-resume-first", 2 * DAY_MS);
      const r1 = await recoverRuntimeState({ home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([scan]);
      expect(existsSync(first)).toBe(false);
      expect(r1.steps.find((s) => s.step === 8)!.detail).toMatchObject({ claudeResumeRemoved: 1, claudeResumeScan: "listed" });
      const marker = readClaudeResumeScanMarker(home);
      expect(marker?.roots).toEqual([scan]);
      expect(marker?.complete).toBe(true);

      // A boot later: a new stale dir exists, and nothing looks for it — the temp folder is not listed.
      const later = plant(scan, "claude-resume-later", 2 * DAY_MS);
      const r2 = await recoverRuntimeState({ home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([scan]); // still the one call from the first boot
      expect(existsSync(later)).toBe(true);
      expect(r2.steps.find((s) => s.step === 8)!.detail).toMatchObject({ claudeResumeRemoved: 0, claudeResumeScan: "marker" });
    });
  });

  test("a deferred sweep (run-home router) records nothing — the late pass owns the listing", async () => {
    await withWorld(async ({ home, scan, rs, store }) => {
      const spy = spyLister();
      const stale = plant(scan, "claude-resume-x", 2 * DAY_MS);
      const r = await recoverRuntimeState({ home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: scan, deferClaudeResumeSweep: true, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([]);
      expect(readClaudeResumeScanMarker(home)).toBeUndefined();
      expect(existsSync(stale)).toBe(true);
      expect(r.steps.find((s) => s.step === 8)!.detail.claudeResumeSweep).toBe("deferred");
    });
  });

  test("known roots stay protected on the listing boot AND on later boots; once the claim ends the dir is swept BY PATH, no listing", async () => {
    await withWorld(async ({ home, scan, rs, store }) => {
      const spy = spyLister();
      const claimed = plant(scan, "claude-resume-claimed", 30 * DAY_MS);
      const nested = join(claimed, "nested", "child");
      mkdirSync(nested, { recursive: true });
      const old = (Date.now() - 30 * DAY_MS) / 1000;
      utimesSync(claimed, old, old); // the nested mkdir just refreshed the staging dir's mtime
      rs.db.run(`INSERT INTO runtime_sessions (winter_session_id, runtime_kind, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
        transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json, active_local_write_root, active_local_write_root_kind)
        VALUES ('s_1', 'claude-agent', 'anthropic', 'anthropic/claude', '/b', 'k', 'k', 'k', 'clean', 'conversation', 'c1', 'recorded', 't', 't', 'idle', '{}', ?, 'sdk-resume-staging')`, [nested]);
      const run = () => recoverRuntimeState({ home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });

      await run();
      expect(existsSync(claimed)).toBe(true); // protected by the nested known root
      expect(readClaudeResumeScanMarker(home)?.pending).toEqual([claimed]);
      await run();
      expect(existsSync(claimed)).toBe(true); // still protected on a marker-only boot
      expect(spy.calls).toEqual([scan]);

      rs.db.run("UPDATE runtime_sessions SET active_local_write_root = NULL, active_local_write_root_kind = NULL WHERE winter_session_id = 's_1'");
      const r3 = await run();
      expect(existsSync(claimed)).toBe(false); // the claim ended: swept by its recorded path
      expect(r3.steps.find((s) => s.step === 8)!.detail).toMatchObject({ claudeResumeRemoved: 1, claudeResumeScan: "marker" });
      expect(spy.calls).toEqual([scan]); // never listed again
      expect(readClaudeResumeScanMarker(home)?.pending).toEqual([]);
    });
  });

  test("a young dir the listing saw is re-checked by path until it is old enough (the 24 h rule still means 24 h)", async () => {
    await withWorld(async ({ home, scan, rs, store }) => {
      const young = plant(scan, "claude-resume-young", 60_000);
      const run = () => recoverRuntimeState({ home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: scan });
      await run();
      expect(existsSync(young)).toBe(true);
      expect(readClaudeResumeScanMarker(home)?.pending).toEqual([young]);
      const t = (Date.now() - 2 * DAY_MS) / 1000;
      utimesSync(young, t, t);
      await run();
      expect(existsSync(young)).toBe(false);
    });
  });

  test("a listing that cannot read the root leaves NO marker (a later boot tries again); a missing root is recorded", async () => {
    await withWorld(async ({ home, scan, rs, store }) => {
      const failing: ClaudeResumeLister = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
      const deps = { home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: scan };
      const r1 = await recoverRuntimeState({ ...deps, listClaudeResumeStaging: failing });
      expect(r1.ok).toBe(true);
      expect(readClaudeResumeScanMarker(home)).toBeUndefined();
      const gone = join(home, "never-created");
      await recoverRuntimeState({ ...deps, claudeResumeScanRoot: gone });
      expect(readClaudeResumeScanMarker(home)?.roots).toEqual([gone]);
    });
  });

  test("a listing cut short by its budget is recorded as such and not retried", async () => {
    await withWorld(async ({ home, scan, rs, store }) => {
      const cut: ClaudeResumeLister = (): ClaudeResumeListing => ({ names: [], entries: 2_000_000, complete: false, absent: false });
      const lines: string[] = [];
      const r = await recoverRuntimeState({ home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: scan, listClaudeResumeStaging: cut, log: (l) => lines.push(l) });
      expect(r.steps.find((s) => s.step === 8)!.detail).toMatchObject({ claudeResumeScan: "listed-partial", claudeResumeEntries: 2_000_000 });
      expect(readClaudeResumeScanMarker(home)).toMatchObject({ complete: false, entries: 2_000_000 });
      expect(lines.some((l) => l.includes("budget"))).toBe(true);
    });
  });
});

describe("recoverRunRoots (the late pass every real daemon runs) — the staging listing happens once per home", () => {
  test("the first pass lists and reconciles; a later pass lists nothing and reconciles nothing new", async () => {
    await withWorld(async ({ home, scan, rs }) => {
      const spy = spyLister();
      const first = plant(scan, "claude-resume-first", 2 * DAY_MS);
      const s1 = stub();
      const r1 = await recoverRunRoots({ home, rs, reconcile: s1.reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([scan]);
      expect(s1.seen).toEqual([first]);
      expect(r1.stagingScan).toBe("listed");
      expect(r1.staging.removed).toBe(1);
      expect(readClaudeResumeScanMarker(home)?.roots).toEqual([scan]);

      const later = plant(scan, "claude-resume-later", 2 * DAY_MS);
      const s2 = stub();
      const r2 = await recoverRunRoots({ home, rs, reconcile: s2.reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([scan]); // not listed again
      expect(s2.seen).toEqual([]);
      expect(existsSync(later)).toBe(true);
      expect(r2.stagingScan).toBe("marker");
    });
  });

  test("a quarantined staging root is kept, and is never reconciled again on any later boot", async () => {
    await withWorld(async ({ home, scan, rs }) => {
      const spy = spyLister();
      const q = plant(scan, "claude-resume-quarantine", 2 * DAY_MS);
      const r1 = await recoverRunRoots({ home, rs, reconcile: stub({ [q]: "quarantined" }).reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(existsSync(q)).toBe(true);
      expect(r1.staging.quarantined).toBe(1);
      expect(quarantinedRunRoots(rs).map((x) => x.root)).toEqual([q]);
      for (let boot = 0; boot < 2; boot++) {
        const s = stub();
        await recoverRunRoots({ home, rs, reconcile: s.reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
        expect(s.seen).toEqual([]);
        expect(existsSync(q)).toBe(true);
      }
      expect(spy.calls).toEqual([scan]);
    });
  });

  test("a root this home's directory row names is reconciled at once on a marker-only boot too — by path, no listing", async () => {
    await withWorld(async ({ home, scan, rs }) => {
      const spy = spyLister();
      await recoverRunRoots({ home, rs, reconcile: stub().reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister }); // the one listing
      const named = plant(scan, "claude-resume-named", 60_000); // young: only the directory row makes it ours
      const unnamed = plant(scan, "claude-resume-unnamed", 60_000);
      rs.db.run("INSERT INTO directory_entries (address, entry_json, updated_at) VALUES (?, ?, 't')", ["winter://session/s_1", JSON.stringify({ configDir: named })]);
      const s = stub();
      await recoverRunRoots({ home, rs, reconcile: s.reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([scan]);
      expect(s.seen).toEqual([named]);
      expect(existsSync(named)).toBe(false);
      expect(existsSync(unnamed)).toBe(true);
    });
  });

  test("a reconcile that throws leaves the root pending: retried by path next boot, still without a listing", async () => {
    await withWorld(async ({ home, scan, rs }) => {
      const spy = spyLister();
      const stuck = plant(scan, "claude-resume-stuck", 2 * DAY_MS);
      const r1 = await recoverRunRoots({ home, rs, reconcile: stub({ [stuck]: "throw" }).reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(r1.staging.failed).toBe(1);
      expect(existsSync(stuck)).toBe(true);
      expect(readClaudeResumeScanMarker(home)?.pending).toEqual([stuck]);
      const s2 = stub();
      const r2 = await recoverRunRoots({ home, rs, reconcile: s2.reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(s2.seen).toEqual([stuck]);
      expect(r2.staging.removed).toBe(1);
      expect(existsSync(stuck)).toBe(false);
      expect(spy.calls).toEqual([scan]);
      expect(readClaudeResumeScanMarker(home)?.pending).toEqual([]);
    });
  });

  test("an unreadable root records nothing; the next boot lists again", async () => {
    await withWorld(async ({ home, scan, rs }) => {
      const failing: ClaudeResumeLister = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
      const r1 = await recoverRunRoots({ home, rs, reconcile: stub().reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: failing });
      expect(r1.stagingScan).toBe("unreadable");
      expect(readClaudeResumeScanMarker(home)).toBeUndefined();
      const spy = spyLister();
      await recoverRunRoots({ home, rs, reconcile: stub().reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([scan]);
    });
  });

  test("a different scan root is a different listing (the marker covers roots, not just the home)", async () => {
    await withWorld(async ({ home, scan, rs }) => {
      const spy = spyLister();
      const other = mkdtempSync(join(tmpdir(), "winter-crs-other-"));
      await recoverRunRoots({ home, rs, reconcile: stub().reconcile, claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister });
      await recoverRunRoots({ home, rs, reconcile: stub().reconcile, claudeResumeScanRoot: other, listClaudeResumeStaging: spy.lister });
      await recoverRunRoots({ home, rs, reconcile: stub().reconcile, claudeResumeScanRoot: other, listClaudeResumeStaging: spy.lister });
      expect(spy.calls).toEqual([scan, other]);
    });
  });
});

describe("Migration C's staging check", () => {
  test("a home whose marker covers the root answers from the marker's pending paths — the root is never listed", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-crs-migc-"));
    const root = mkdtempSync(join(tmpdir(), "winter-crs-migc-scan-"));
    mkdirSync(join(root, "claude-resume-aaa"));
    const spy = spyLister();
    expect(claudeResumeStagingPresent(home, root, spy.lister)).toBe(true); // no marker yet: one bounded listing
    expect(spy.calls).toEqual([root]);
    recordClaudeResumeScan(home, root, { complete: true, entries: 1, found: 1, pending: [] });
    expect(claudeResumeStagingPresent(home, root, spy.lister)).toBe(false); // covered: no listing, nothing pending
    expect(spy.calls).toEqual([root]);
    recordClaudeResumeScan(home, root, { complete: true, entries: 1, found: 1, pending: [join(root, "claude-resume-aaa")] });
    expect(claudeResumeStagingPresent(home, root, spy.lister)).toBe(true); // a pending path that still exists holds phase 2
    expect(spy.calls).toEqual([root]);
  });
});

describe("through startRuntimeState (the daemon's own wiring)", () => {
  const SETTINGS = Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } });

  test("boot twice on one home: the first sweeps, the second never lists the scan root", async () => {
    await withWorld(async ({ home, scan, store, rs }) => {
      rs.close(); // startRuntimeState opens the home's db itself
      const spy = spyLister();
      const first = plant(scan, "claude-resume-boot1", 2 * DAY_MS);
      const boot = async (): Promise<number | string | string[] | undefined> => {
        const state = await startRuntimeState({ home, store, settings: () => SETTINGS, recovery: { claudeResumeScanRoot: scan, listClaudeResumeStaging: spy.lister } });
        const rt = runtimeStateOnline(state);
        if (!rt) throw new Error("runtime state unavailable");
        try { return rt.lastRecovery.steps.find((s) => s.step === 8)?.detail.claudeResumeScan; } finally { await rt.close(); }
      };
      expect(await boot()).toBe("listed");
      expect(existsSync(first)).toBe(false);
      const second = plant(scan, "claude-resume-boot2", 2 * DAY_MS);
      expect(await boot()).toBe("marker");
      expect(existsSync(second)).toBe(true);
      expect(spy.calls).toEqual([scan]);
      expect(JSON.parse(readFileSync(claudeResumeScanMarkerPath(home), "utf8")).roots).toEqual([scan]);
    });
  });
});
