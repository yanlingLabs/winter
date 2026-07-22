import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry, HookFacade } from "../../src/plugins/hook-registry";
import type { HookEventPayload, HookResult, HookRunner, HookSpec } from "../../src/plugins/hook-runner";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { Settings, hooksEnabledFrom } from "../../src/settings";

// Task 9 (CC project-folder-mechanics, FINAL task): makes `hooks.enabled` per-project through
// ProjectSettingsResolver (Task 6) — same "(cwd) => projectSettings.effective(cwd ?? null)?.X"
// pattern Tasks 7-8 established for permissions/reviewer/toolSearch/lsp.autoDiagnostics — but
// HookFacade.runFor only ever has a `sessionId` in scope (its four engine.ts call sites, unlike
// the reviewer/toolSearch ones, never had a cwd to thread directly), so the facade resolves its
// OWN cwd via an optional `cwdForSession` dep, preferring `extra.cwd` when the caller already
// supplied one (the session-start call site does: `runFor("session-start", { cwd }, sessionId)`).
//
// Exercised at the HookFacade unit level — hook-registry.test.ts's own harness (FakeRunner, plain
// HookRegistry.rebuild) — rather than through a full AgentEngine/SessionStore, since the facade's
// new `cwdForSession` dep is exactly the seam daemon.ts wires `store.meta(sid).cwd` through; a stub
// function is all that seam needs to be exercised here. Every test uses a fresh mkdtemp'd
// directory — never ~/.norma (project rule).

function tmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Minimal valid Settings — mirrors project-settings-resolver.test.ts's own helper. */
function minimalBase(overrides: Record<string, unknown> = {}): Settings {
  return Settings.parse({
    schemaVersion: 2,
    provider: { type: "codex-oauth", model: "x" },
    ...overrides,
  });
}

/** A fake HookRunner recording every call it receives — same shape as hook-registry.test.ts's own
 *  FakeRunner, minus the queued-results machinery this suite doesn't need (every hook here just
 *  needs to prove whether it ran, not control WHEN it resolves). */
class FakeRunner {
  calls: Array<{ spec: HookSpec; payload: HookEventPayload }> = [];
  run(spec: HookSpec, payload: HookEventPayload): Promise<HookResult> {
    this.calls.push({ spec, payload });
    return Promise.resolve({ status: "ok", stdout: "" });
  }
}

/** One hook registered for "pre-tool" — the fixture every test but the extra.cwd-precedence one
 *  (which needs "session-start") uses. */
function registryWithOnePreToolHook(): HookRegistry {
  const registry = new HookRegistry();
  registry.rebuild([{ id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "pre-tool", command: "./a.sh" }] }]);
  return registry;
}

/** The exact `hooksEnabledHot` shape daemon.ts wires (Task 9): a live per-project read through the
 *  resolver, `true` when `effective()` degrades to a null base (mirrors the daemon's fail-open
 *  default for a malformed/absent settings.json — irrelevant here since `base` is always valid,
 *  included for parity with the real getter's exact shape). */
function hooksEnabledHotFor(resolver: ProjectSettingsResolver): (cwd?: string | null) => boolean {
  return (cwd) => {
    const s = resolver.effective(cwd ?? null);
    return s ? hooksEnabledFrom(s) : true;
  };
}

describe("hooks.enabled becomes per-project via ProjectSettingsResolver (Task 9)", () => {
  test("a trusted project's .norma/settings.json sets hooks.enabled:false -> the hook does NOT run for a session whose cwdForSession resolves there; a control session in another project still runs it", async () => {
    const projectCwd = tmpDir("norma-hooks-project-");
    mkdirSync(join(projectCwd, ".norma"), { recursive: true });
    writeFileSync(join(projectCwd, ".norma", "settings.json"), JSON.stringify({ hooks: { enabled: false } }));
    const controlCwd = tmpDir("norma-hooks-control-"); // a different project — no overlay at all

    const base = minimalBase();
    const trust = { isTrusted: (dir: string) => dir === projectCwd };
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });

    const cwdBySession: Record<string, string> = { "sess-project": projectCwd, "sess-control": controlCwd };
    const runner = new FakeRunner();
    const facade = new HookFacade({
      registry: registryWithOnePreToolHook(),
      runner: runner as unknown as HookRunner,
      hooksEnabled: hooksEnabledHotFor(resolver),
      cwdForSession: (sid) => cwdBySession[sid] ?? null,
    });

    const projectResults = await facade.runFor("pre-tool", {}, "sess-project");
    expect(projectResults).toEqual([]);
    expect(runner.calls.length).toBe(0);

    const controlResults = await facade.runFor("pre-tool", {}, "sess-control");
    expect(controlResults.length).toBe(1);
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]!.spec.pluginId).toBe("alpha");
  });

  test("session-start's extra.cwd takes precedence over cwdForSession", async () => {
    const projectCwd = tmpDir("norma-hooks-extracwd-project-");
    mkdirSync(join(projectCwd, ".norma"), { recursive: true });
    writeFileSync(join(projectCwd, ".norma", "settings.json"), JSON.stringify({ hooks: { enabled: false } }));
    const controlCwd = tmpDir("norma-hooks-extracwd-control-"); // cwdForSession would point here (hooks on)

    const base = minimalBase();
    const trust = { isTrusted: (dir: string) => dir === projectCwd };
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });

    const registry = new HookRegistry();
    registry.rebuild([{ id: "alpha", dir: "/plugins/alpha", hooks: [{ event: "session-start", command: "./start.sh" }] }]);
    const runner = new FakeRunner();
    const facade = new HookFacade({
      registry,
      runner: runner as unknown as HookRunner,
      hooksEnabled: hooksEnabledHotFor(resolver),
      cwdForSession: () => controlCwd, // would run if this were consulted instead of extra.cwd
    });

    const results = await facade.runFor("session-start", { cwd: projectCwd }, "sess-x");
    expect(results).toEqual([]); // extra.cwd (project, hooks off) wins over cwdForSession (control)
    expect(runner.calls.length).toBe(0);
  });

  test("no cwdForSession dep at all (every pre-Task-9 HookFacade construction site) -> cwd resolves null -> hook RUNS (base default true, byte-identical degrade)", async () => {
    const base = minimalBase();
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => false } });
    const runner = new FakeRunner();
    const facade = new HookFacade({
      registry: registryWithOnePreToolHook(),
      runner: runner as unknown as HookRunner,
      hooksEnabled: hooksEnabledHotFor(resolver),
      // no cwdForSession dep — matches every existing HookFacade construction (hook-registry.test.ts, daemon.ts pre-Task-9)
    });

    const results = await facade.runFor("pre-tool", {}, "sess-unknown");
    expect(results.length).toBe(1);
    expect(runner.calls.length).toBe(1);
  });

  test("cwdForSession explicitly returning null (e.g. a session with no cwd) -> hook RUNS (base default true, byte-identical degrade)", async () => {
    const base = minimalBase();
    const resolver = new ProjectSettingsResolver({ base: () => base, trust: { isTrusted: () => false } });
    const runner = new FakeRunner();
    const facade = new HookFacade({
      registry: registryWithOnePreToolHook(),
      runner: runner as unknown as HookRunner,
      hooksEnabled: hooksEnabledHotFor(resolver),
      cwdForSession: () => null,
    });

    const results = await facade.runFor("pre-tool", {}, "sess-null-cwd");
    expect(results.length).toBe(1);
    expect(runner.calls.length).toBe(1);
  });

  test("no-hooks fast path still short-circuits BEFORE cwd resolution — cwdForSession is never called", async () => {
    const registry = new HookRegistry(); // never rebuilt — no hooks for any event
    const runner = new FakeRunner();
    let cwdLookups = 0;
    const facade = new HookFacade({
      registry,
      runner: runner as unknown as HookRunner,
      hooksEnabled: () => true,
      cwdForSession: () => {
        cwdLookups++;
        return "/some/cwd";
      },
    });

    const results = await facade.runFor("pre-tool", {}, "sess-1");
    expect(results).toEqual([]);
    expect(runner.calls.length).toBe(0);
    expect(cwdLookups).toBe(0); // the empty-registry fast path never resolves cwd either
  });
});
