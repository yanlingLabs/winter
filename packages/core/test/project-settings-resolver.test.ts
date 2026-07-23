import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSettingsResolver } from "../src/project-settings";
import { Settings, workflowsEnabledFrom } from "../src/settings";

// Task 6: the cwd-keyed, mtime-cached "effective settings" read-through built on Task 5's
// mergeSettings. Every test uses a fresh mkdtemp'd directory — never ~/.norma (project rule).

function tmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Minimal valid Settings — mirrors project-settings-merge.test.ts's own helper. */
function minimalBase(overrides: Record<string, unknown> = {}): Settings {
  return Settings.parse({
    schemaVersion: 2,
    provider: { type: "codex-oauth", model: "x" },
    ...overrides,
  });
}

/** A trust stub whose answer can be flipped mid-test (test g). */
function trustStub(initial: boolean): { isTrusted(dir: string): boolean; set(v: boolean): void } {
  let trusted = initial;
  return {
    isTrusted: () => trusted,
    set(v: boolean) {
      trusted = v;
    },
  };
}

describe("ProjectSettingsResolver", () => {
  test("(a) trusted cwd: .norma/settings.json overlay merges into base", () => {
    const cwd = tmpDir("norma-psr-a-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(false);
  });

  test("(b) untrusted cwd: BOTH project file and settings.local.json are ignored (fix-wave A1: a repo can git add -f a settings.local.json, so gitignore is not a trust boundary)", () => {
    const cwd = tmpDir("norma-psr-b-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    writeFileSync(join(cwd, ".norma", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/x"] } }));
    const base = minimalBase({ reviewer: { enabled: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => false } });

    const eff = resolver.effective(cwd);
    expect(eff?.reviewer?.enabled).toBe(true); // untrusted project file never read
    expect(eff?.permissions?.additionalDirectories).toBeUndefined(); // untrusted local overlay never read either — CC-parity
  });

  test("(b2) trusted cwd: settings.local.json still merges (the trusted-cwd-applies-local case fix-wave A1 keeps)", () => {
    const cwd = tmpDir("norma-psr-b2-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["/x"] } }));
    const base = minimalBase();
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    const eff = resolver.effective(cwd);
    expect(eff?.permissions?.additionalDirectories).toEqual(["/x"]); // trusted -> local overlay still applies
  });

  test("(c) null cwd returns base verbatim — the SAME object, not a copy", () => {
    const base = minimalBase();
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    expect(resolver.effective(null)).toBe(base);
  });

  test("(d) hot-reload: an out-of-band rewrite is picked up on the next call (mtime-checked, no watcher)", () => {
    const cwd = tmpDir("norma-psr-d-");
    const file = join(cwd, ".norma", "settings.json");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(file, JSON.stringify({ reviewer: { enabled: true } }));
    const base = minimalBase();
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(true);

    writeFileSync(file, JSON.stringify({ reviewer: { enabled: false } }));
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future); // force a strictly-newer mtime, independent of fs clock resolution

    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(false);
  });

  test("(e) malformed project JSON fails safe to base, and is never cached — fixing the file is picked up immediately", () => {
    const cwd = tmpDir("norma-psr-e-");
    const file = join(cwd, ".norma", "settings.json");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(file, "{ not json at all");
    const base = minimalBase({ reviewer: { enabled: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    expect(resolver.effective(cwd)).toBe(base); // fail-safe: byte-identical (same reference) fallback

    // No mtime bump here on purpose: a torn read must leave NO cache entry at all, so the very
    // next call re-reads regardless of whether the file's mtime/size happen to have changed.
    writeFileSync(file, JSON.stringify({ reviewer: { enabled: false } }));
    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(false);
  });

  test("(f) base-swap invalidation: a new base() reference is picked up even with unchanged overlay files", () => {
    const cwd = tmpDir("norma-psr-f-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    let base = minimalBase({ reviewer: { enabled: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(false); // overlay applies over base's true

    // Simulate SettingsWatcher's atomic swap: a BRAND NEW object (reviewer.enabled unchanged,
    // but titles.enabled newly true) — reference identity is what must invalidate the cache here.
    base = minimalBase({ reviewer: { enabled: true }, titles: { enabled: true } });
    const eff = resolver.effective(cwd);
    expect(eff?.reviewer?.enabled).toBe(false); // same project overlay, re-applied
    expect(eff?.titles?.enabled).toBe(true); // proves the NEW base was actually used, not a stale cached merge
  });

  test("(g) trust-flip invalidation: trusting a project mid-session applies its overlay on the next call", () => {
    const cwd = tmpDir("norma-psr-g-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true } });
    const trust = trustStub(false);
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });

    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(true); // untrusted -> ignored

    trust.set(true); // same files, completely untouched
    expect(resolver.effective(cwd)?.reviewer?.enabled).toBe(false); // now trusted -> applied
  });

  test("(h1) symlinked .norma directory is refused — overlay not applied, effective is base verbatim", () => {
    const cwd = tmpDir("norma-psr-h1-");
    const realDir = tmpDir("norma-psr-h1-real-");
    writeFileSync(join(realDir, "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    symlinkSync(realDir, join(cwd, ".norma")); // cwd/.norma is a symlink to a real dir elsewhere
    const base = minimalBase({ reviewer: { enabled: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    expect(resolver.effective(cwd)).toBe(base);
  });

  test("(h2) symlinked settings.local.json inside a REAL .norma dir is refused too", () => {
    const cwd = tmpDir("norma-psr-h2-");
    const decoy = tmpDir("norma-psr-h2-decoy-");
    mkdirSync(join(cwd, ".norma"), { recursive: true }); // .norma itself is real
    writeFileSync(join(decoy, "x.json"), JSON.stringify({ permissions: { additionalDirectories: ["/evil"] } }));
    symlinkSync(join(decoy, "x.json"), join(cwd, ".norma", "settings.local.json"));
    const base = minimalBase();
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    expect(resolver.effective(cwd)).toBe(base);
  });

  test("(i) cache hit: two consecutive unchanged calls return the SAME object reference (no re-merge)", () => {
    const cwd = tmpDir("norma-psr-i-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const base = minimalBase({ reviewer: { enabled: true } });
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => true } });

    const first = resolver.effective(cwd);
    const second = resolver.effective(cwd);
    expect(second).toBe(first);
  });
});

// Task B1 (CC-parity phase 3, Workflows Track B): workflows.{enabled,keywordTrigger} become
// per-project the SAME way reviewer.enabled does above (tests (a)/(b)) — mirrored here rather than
// re-using `reviewer.enabled` as the demonstration field, since this task's own daemon.ts getter
// composes the resolver's `effective()` read with the NEW workflowsEnabledFrom helper (settings.ts),
// not just a raw property read.
describe("workflows.{enabled,keywordTrigger} become per-project via ProjectSettingsResolver", () => {
  test("an untrusted project's workflows.enabled:false overlay is IGNORED (base's default-ON wins); a trusted project's applies", () => {
    const untrustedCwd = tmpDir("norma-psr-wf-untrusted-");
    mkdirSync(join(untrustedCwd, ".norma"), { recursive: true });
    writeFileSync(join(untrustedCwd, ".norma", "settings.json"), JSON.stringify({ workflows: { enabled: false } }));

    const trustedCwd = tmpDir("norma-psr-wf-trusted-");
    mkdirSync(join(trustedCwd, ".norma"), { recursive: true });
    writeFileSync(join(trustedCwd, ".norma", "settings.json"), JSON.stringify({ workflows: { enabled: false } }));

    const base = minimalBase();
    const trust = { isTrusted: (dir: string) => dir === trustedCwd }; // only the trusted cwd is trusted
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });

    // Same composition daemon.ts's real `workflowsEnabled` getter uses: workflowsEnabledFrom over
    // the resolver's per-project effective() read (falling back to base when effective() is null).
    const workflowsEnabled = (cwd: string) => workflowsEnabledFrom(resolver.effective(cwd) ?? base);

    expect(workflowsEnabled(untrustedCwd)).toBe(true); // untrusted overlay never read — default-ON wins
    expect(workflowsEnabled(trustedCwd)).toBe(false); // trusted overlay applies
  });
});
