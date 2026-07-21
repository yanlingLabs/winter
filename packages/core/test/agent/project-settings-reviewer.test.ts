import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { Settings } from "../../src/settings";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { Provider } from "../../src/providers/types";
import { stubRegistry, bashTurn, stubReviewer } from "./engine-reviewer.test";

// Task 8: makes ProjectSettingsResolver (Task 6) LIVE for the reviewer getters
// (`reviewerEnabled`/`reviewerAllow`/`reviewerClasses`) — same shape as Task 7's
// project-settings-wiring.test.ts (ONE engine + ONE shared resolver instance serving TWO
// DIFFERENT session cwds, mirroring daemon.ts's single `projectSettings` resolver serving every
// project), but exercising the REVIEWER path this task converts instead of the permission path
// Task 7 converted.

function tmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Minimal valid Settings — mirrors project-settings-wiring.test.ts's own helper. */
function minimalBase(overrides: Record<string, unknown> = {}): Settings {
  return Settings.parse({
    schemaVersion: 2,
    provider: { type: "codex-oauth", model: "x" },
    ...overrides,
  });
}

/** Builds a real AgentEngine wired the same way daemon.ts wires one, minus everything these tests
 *  don't touch — same shape as project-settings-wiring.test.ts's own buildEngine, plus the
 *  reviewer/reviewerEnabled/reviewerAllow/reviewerClasses fields THIS suite exercises. Unlike
 *  engine-steer.test.ts's setupEngine (one fixed `cwd` baked in at construction), `dirs` here reads
 *  each session's cwd LIVE off the store (mirrors daemon.ts's real `sessionDirs` construction) so
 *  ONE engine can run sessions against DIFFERENT project directories. */
function buildEngine(
  provider: Provider,
  opts: {
    registry: ToolRegistry;
    reviewer?: unknown;
    reviewerEnabled?: (cwd?: string) => boolean | undefined;
    reviewerAllow?: (cwd?: string) => string[] | undefined;
    reviewerClasses?: (cwd?: string) => { bash?: boolean; fs?: boolean; external?: boolean } | undefined;
  },
): { engine: AgentEngine; store: SessionStore; hub: SessionHub; broker: ApprovalBroker } {
  const home = tmpDir("norma-psr-home-");
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories((sid) => {
    const cwd = store.meta(sid).cwd;
    return cwd ? [cwd] : [];
  });
  const skillsHome = tmpDir("norma-psr-skills-");
  const skills = new SkillStore({ normaHome: skillsHome, trust: new TrustStore(join(skillsHome, "trust.json")) });
  const assemblerHome = tmpDir("norma-psr-actx-");
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: new TrustStore(join(assemblerHome, "trust.json")),
    skills,
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store,
    hub,
    registry: opts.registry,
    broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500, // short fuse — a wrongly-appearing card fails fast instead of hanging
    assembler,
    compactor,
    reviewer: opts.reviewer as any,
    reviewerEnabled: opts.reviewerEnabled,
    reviewerAllow: opts.reviewerAllow,
    reviewerClasses: opts.reviewerClasses,
  });
  return { engine, store, hub, broker };
}

describe("reviewer.enabled becomes per-project via ProjectSettingsResolver", () => {
  test("a trusted project's .norma/settings.json sets reviewer.enabled:false -> an auto-policy bash call runs WITHOUT a tool_review there; a control project still gets reviewed", async () => {
    const projectCwd = tmpDir("norma-psr-project-");
    mkdirSync(join(projectCwd, ".norma"), { recursive: true });
    writeFileSync(join(projectCwd, ".norma", "settings.json"), JSON.stringify({ reviewer: { enabled: false } }));
    const controlCwd = tmpDir("norma-psr-control-"); // a different project — no overlay at all

    const base = minimalBase();
    // Trust stub (per the brief): only the project cwd is trusted.
    const trust = { isTrusted: (dir: string) => dir === projectCwd };
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });

    const { registry, calls } = stubRegistry();
    // "safe" verdict: the control session's reviewed run needs no human card — reviewAndDispatch's
    // "safe" branch (engine.ts) executes directly, so this stays a plain 2-round turn (tool_call +
    // final text) exactly like the project session's unreviewed run. Both sessions consume exactly
    // 2 rounds each from the ONE shared FakeProvider script below — no round-counting mismatch to
    // account for (unlike project-settings-wiring.test.ts's denial case, which consumes only 1).
    const reviewer = stubReviewer("safe");
    const provider = new FakeProvider([...bashTurn("rm -rf project-scratch"), ...bashTurn("rm -rf control-scratch")]);
    const { engine, store } = buildEngine(provider, {
      registry,
      reviewer: reviewer as any,
      reviewerEnabled: (cwd) => resolver.effective(cwd ?? null)?.reviewer?.enabled,
      reviewerAllow: (cwd) => resolver.effective(cwd ?? null)?.reviewer?.allow ?? [],
      reviewerClasses: (cwd) => resolver.effective(cwd ?? null)?.reviewer?.classes,
    });

    // Session 1: the PROJECT cwd — its own settings.json turned the reviewer off for THIS project.
    const projectSessionId = store.createSession("global", { cwd: projectCwd, approvalPolicy: "auto" });
    await engine.runTurn(projectSessionId);
    const projectEvents = store.read(projectSessionId);
    expect(projectEvents.some((e) => e.type === "tool_review")).toBe(false);
    expect(calls.length).toBe(1); // ran regardless — reviewer off just means unreviewed, not blocked

    // Session 2: a DIFFERENT project — no overlay reaches it, so the reviewer's default-on applies.
    const controlSessionId = store.createSession("global", { cwd: controlCwd, approvalPolicy: "auto" });
    await engine.runTurn(controlSessionId);
    const controlEvents = store.read(controlSessionId);
    expect(controlEvents.some((e) => e.type === "tool_review")).toBe(true);
    expect(calls.length).toBe(2); // "safe" verdict -> ran too
  });
});
