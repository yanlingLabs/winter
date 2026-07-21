import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerWebTools } from "../../src/agent/tools/web";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { PermissionRules } from "../../src/agent/permission-rules";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { Settings } from "../../src/settings";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { Provider, ProviderEvent } from "../../src/providers/types";
import { stubRegistry, bashTurn } from "./engine-reviewer.test";

// Task 7: makes ProjectSettingsResolver (Task 6) LIVE for two permission getters —
// `dangerousDomainsAdded` (web_fetch's floor) and PermissionRules' `globalAllow` (the
// `permissions.allow` CC-grammar rules) — so a project's OWN `.norma/settings.json` can widen
// either, scoped to that project only. This drives the REAL dispatch loop end to end (not the
// resolver or PermissionRules in isolation — each already has its own unit suite) through a
// hand-built engine (setupEngine's own harness fixes a single cwd per engine instance; these
// tests need ONE engine/resolver serving TWO DIFFERENT cwds, to prove the per-project split
// against a single shared instance — the same shape daemon.ts's one `projectSettings` resolver
// serving every project actually has).

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

/** Builds a real AgentEngine wired the same way daemon.ts wires one, minus everything these
 *  tests don't touch (mcp/reviewer/titler/etc. all stay absent, unchanged behavior). Unlike
 *  engine-steer.test.ts's setupEngine (one fixed `cwd` baked in at construction), `dirs` here
 *  reads each session's cwd LIVE off the store (mirrors daemon.ts's real `sessionDirs`
 *  construction) so ONE engine can run sessions against DIFFERENT project directories. */
function buildEngine(
  provider: Provider,
  opts: { registry: ToolRegistry; permissionRules?: PermissionRules; dangerousDomainsAdded?: (cwd?: string) => string[] | undefined },
): { engine: AgentEngine; store: SessionStore; hub: SessionHub; broker: ApprovalBroker } {
  const home = tmpDir("norma-psw-home-");
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories((sid) => {
    const cwd = store.meta(sid).cwd;
    return cwd ? [cwd] : [];
  });
  const skillsHome = tmpDir("norma-psw-skills-");
  const skills = new SkillStore({ normaHome: skillsHome, trust: new TrustStore(join(skillsHome, "trust.json")) });
  const assemblerHome = tmpDir("norma-psw-actx-");
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
    permissionRules: opts.permissionRules,
    dangerousDomainsAdded: opts.dangerousDomainsAdded,
  });
  return { engine, store, hub, broker };
}

/** A web tools registry whose fetchFn never hits the real network — records every URL it was
 *  asked to fetch. Mirrors permission-gate-order.test.ts's own `buildWebRegistry` precedent. */
function buildWebRegistry(): { registry: ToolRegistry; fetchCalls: string[] } {
  const registry = new ToolRegistry();
  const fetchCalls: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetchCalls.push(String(url));
    return new Response("<html><body><h1>hi</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  registerWebTools(registry, { fetchFn: fakeFetch });
  return { registry, fetchCalls };
}

/** One round: model calls web_fetch(url) then stops with tool_calls; round 2 ends the turn. */
function webFetchTurn(url: string, callId = "c1"): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId, name: "web_fetch", argsJson: JSON.stringify({ url }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

/** An approval-card watcher that always resolves the same way — mirrors permission-gate-order.
 *  test.ts's own `approver` idiom. */
function approver(broker: ApprovalBroker, sessionId: string, approved: boolean): HubClient {
  return {
    clientName: approved ? "auto-approver" : "auto-denier",
    deliver(e) {
      if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, approved, approved ? "auto-approver" : "auto-denier");
      return true;
    },
  };
}

describe("dangerousDomainsAdded becomes per-project via ProjectSettingsResolver", () => {
  test("a trusted project's .norma/settings.json adds a dangerous domain -> web_fetch to it CARDS there; a control cwd elsewhere runs it cardless", async () => {
    const projectCwd = tmpDir("norma-psw-dd-project-");
    mkdirSync(join(projectCwd, ".norma"), { recursive: true });
    writeFileSync(
      join(projectCwd, ".norma", "settings.json"),
      JSON.stringify({ permissions: { dangerousDomains: { added: ["evil-example.net"] } } }),
    );
    const controlCwd = tmpDir("norma-psw-dd-control-"); // a different project — no overlay at all

    const base = minimalBase();
    // Trust stub (per the brief): only the project cwd is trusted.
    const trust = { isTrusted: (dir: string) => dir === projectCwd };
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });

    const { registry, fetchCalls } = buildWebRegistry();
    // A human DENIAL ends the turn immediately after the ONE tool_call round (requestApproval's
    // explicit "ends the turn and hands control back to the user" short-circuit — no follow-up
    // model round) — so session 1 below consumes only `webFetchTurn(x)`'s FIRST round. Session 2's
    // cardless run needs the full 2-round shape (tool result, then the model's final response).
    const provider = new FakeProvider([webFetchTurn("https://evil-example.net/x", "c1")[0]!, ...webFetchTurn("https://evil-example.net/y", "c2")]);
    const { engine, store, hub, broker } = buildEngine(provider, {
      registry,
      dangerousDomainsAdded: (cwd) => resolver.effective(cwd ?? null)?.permissions?.dangerousDomains?.added,
    });

    // Session 1: the PROJECT cwd — its own settings.json added this domain, so it must card.
    const projectSessionId = store.createSession("global", { cwd: projectCwd, approvalPolicy: "ask" });
    hub.attach(approver(broker, projectSessionId, false), projectSessionId, 0); // deny — only proving the card fired
    await engine.runTurn(projectSessionId);
    const projectEvents = store.read(projectSessionId);
    expect(projectEvents.some((e) => e.type === "approval_requested")).toBe(true);
    expect(fetchCalls).toEqual([]); // denied -> never actually fetched

    // Session 2: a DIFFERENT project — same shipped-safe host, but THIS cwd's effective settings
    // carry no addition, so the floor has nothing extra to check it against.
    const controlSessionId = store.createSession("global", { cwd: controlCwd, approvalPolicy: "ask" });
    await engine.runTurn(controlSessionId);
    const controlEvents = store.read(controlSessionId);
    expect(controlEvents.some((e) => e.type === "approval_requested")).toBe(false);
    expect(fetchCalls).toEqual(["https://evil-example.net/y"]); // ran cardless
  });
});

describe("permissions.allow becomes per-project via ProjectSettingsResolver (PermissionRules.globalAllow)", () => {
  test("a trusted project's .norma/settings.json permissions.allow lets a matching bash rule run WITHOUT a card there, but the SAME command still cards in a control project", async () => {
    const projectCwd = tmpDir("norma-psw-allow-project-");
    mkdirSync(join(projectCwd, ".norma"), { recursive: true });
    writeFileSync(join(projectCwd, ".norma", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(foo:*)"] } }));
    const controlCwd = tmpDir("norma-psw-allow-control-"); // a different project — no overlay at all

    const base = minimalBase();
    const trust = { isTrusted: (dir: string) => dir === projectCwd };
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });
    const normaHome = tmpDir("norma-psw-allow-home-");
    const permissionRules = new PermissionRules({
      globalAllow: (projectRoot) => resolver.effective(projectRoot)?.permissions?.allow ?? ["Computer"],
      normaHome,
    });

    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider([...bashTurn("foo bar"), ...bashTurn("foo bar")]);
    const { engine, store, hub, broker } = buildEngine(provider, { registry, permissionRules });

    // Session 1: the PROJECT cwd — its settings.json's permissions.allow covers "foo bar".
    const projectSessionId = store.createSession("global", { cwd: projectCwd, approvalPolicy: "ask" });
    await engine.runTurn(projectSessionId);
    const projectEvents = store.read(projectSessionId);
    expect(projectEvents.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls.length).toBe(1); // ran cardless — the project rule matched

    // Session 2: a DIFFERENT project — no such rule reaches it, so the same command still cards.
    const controlSessionId = store.createSession("global", { cwd: controlCwd, approvalPolicy: "ask" });
    hub.attach(approver(broker, controlSessionId, true), controlSessionId, 0);
    await engine.runTurn(controlSessionId);
    const controlEvents = store.read(controlSessionId);
    expect(controlEvents.some((e) => e.type === "approval_requested")).toBe(true);
    expect(calls.length).toBe(2); // approved -> ran too
  });
});
