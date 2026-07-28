import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerComputerTool } from "../../src/agent/tools/computer";
import { registerBashTool } from "../../src/agent/tools/bash";
import { registerTaskStopTool } from "../../src/agent/tools/task-stop";
import { registerSessionSpawnTool } from "../../src/agent/tools/session-spawn";
import { registerPushNotificationTool } from "../../src/agent/tools/push-notification";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerSearchTool } from "../../src/agent/tools/search";
import { registerWebTools } from "../../src/agent/tools/web";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

/**
 * Task 3 (R-T3): dispatch's toolset historically had no ToolSearch (bug #7), so its two
 * `deferred: true` web tools (web_fetch/web_search) were advertised but permanently uncallable —
 * a reviewer reproduced the catch-22 end to end this session. Task 2's Search tool
 * (modes: ["chat","dispatch"], NOT deferred) is dispatch's replacement: this file pins that
 * dispatch drops web_fetch/web_search and keeps Search, that Search is actually callable from a
 * real dispatch turn, and that dispatch's own instructions stop pointing the model at a tool it
 * can no longer see.
 *
 * Full production-shaped surface (mirrors mode-toolset-equivalence.test.ts / chat-mode-allowlist
 * .test.ts's own harnesses) — `toolSearch: { enabled: () => undefined }` is the config OBJECT
 * present with `enabled` resolving undefined (daemon.ts's real shape when the user never touched
 * the setting), deliberately not `{ enabled: () => true }`.
 */
function setup(script: ProviderEvent[][]) {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-search-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-dispatch-search-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerComputerTool(registry);
  registerBashTool(registry);
  registerTaskStopTool(registry);
  registerSessionSpawnTool(registry);
  registerPushNotificationTool(registry);
  registerAskUserTool(registry);
  registerSearchTool(registry, {
    secret: async () => "exa_test_key",
    fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      results: [{ title: "Result", url: "https://example.com", text: "an excerpt" }],
    }), { status: 200 })) as typeof fetch,
  });
  registerWebTools(registry);
  registerToolSearchTool(registry);

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-dispatch-search-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    toolSearch: { enabled: () => undefined },
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: "dispatch" });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);

  return {
    engine, sessionId, provider, events,
    turn: async () => { await engine.runTurn(sessionId); },
    // Union of specs-visible names AND names advertised in the "# Deferred tools" bullet list —
    // mirrors mode-toolset-equivalence.test.ts's own `offered()` helper. Both come from the SAME
    // real `provider.requests[...]` entry, never a constant.
    offered(): string[] {
      const specNames = provider.requests.flatMap((r) => (r.tools ?? []).map((t) => t.name));
      // Negative lookahead excludes "## Available capabilities" skills bullets (`- **name** —
      // description`, context.ts) — same bullet shape as "# Deferred tools" but a different list;
      // dispatch has no Skill eligibility so this never actually fires here, but mirrors
      // mode-toolset-equivalence.test.ts's own fix (R-T3) so the two harnesses' `offered()` can't
      // silently drift apart on what counts as "offered".
      const deferredNames = provider.requests.flatMap((r) => [...(r.instructions ?? "").matchAll(/^- (?!\*\*)(\S+) —/gm)].map((m) => m[1]!));
      return [...new Set([...specNames, ...deferredNames])];
    },
    instructions(): string {
      return provider.requests.at(-1)?.instructions ?? "";
    },
  };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];
const call = (callId: string, name: string, args: unknown): ProviderEvent[] =>
  [{ type: "tool_call", callId, name, argsJson: JSON.stringify(args) }, done("tool_calls")];

function toolResultFor(events: SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> {
  const e = events.find((e) => e.type === "tool_result" && e.callId === callId);
  if (!e || e.type !== "tool_result") throw new Error(`expected a tool_result for ${callId}`);
  return e;
}

describe("dispatch's web tools (R-T3)", () => {
  test("dispatch is offered Search, and NOT web_fetch/web_search", async () => {
    const h = setup([text("hi")]);
    await h.turn();
    const offered = h.offered();
    expect(offered).toContain("Search");
    expect(offered).not.toContain("web_fetch");
    expect(offered).not.toContain("web_search");
  });

  test("dispatch gets ToolSearch, so its deferred push_notification is loadable at last", async () => {
    const h = setup([text("hi")]);
    await h.turn();
    expect(h.offered()).toContain("ToolSearch");
  });

  test("dispatch's instructions never mention web_search", async () => {
    const h = setup([text("hi")]);
    await h.turn();
    // The prompt used to say "prefer web_search/web_fetch" for tools dispatch could never load.
    // Swapping the tool without fixing the sentence would just trade one unusable instruction
    // for another.
    expect(h.instructions()).not.toContain("web_search");
    expect(h.instructions()).not.toContain("web_fetch");
    expect(h.instructions()).toContain("Search");
  });

  test("dispatch can actually CALL Search end to end", async () => {
    const h = setup([call("srch1", "Search", { query: "anything" }), text("done")]);
    await h.turn();
    const result = toolResultFor(h.events, "srch1");
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("https://example.com");
  });
});

// Whole-branch review FIX 2: `web_search` is registered `deferred: true` (web.ts) but `modes:
// ["code"]` — dispatch was never OFFERED it at all (this file's own tests above pin that). Before
// this fix, engine.ts's deferred-builtin pre-check was mode-aware but allowTools-BLIND: it fired
// for web_search in dispatch regardless of eligibility, answering "tool web_search is deferred —
// load its schema via ToolSearch first" — sending the model to ToolSearch, which correctly reports
// no match (it IS allowTools-aware), and back to calling web_search again: an infinite loop, the
// reviewer's own reproduction. The fix adds `offered(call.name) &&` to that pre-check so an
// off-list deferred tool falls through to the terminal `!offered` guard instead.
describe("whole-branch review FIX 2: an off-list deferred tool terminates instead of looping", () => {
  test("web_search call in dispatch -> terminal 'not available' (not the deferral advice); ToolSearch(select:web_search) still returns the no-match branch", async () => {
    const h = setup([
      call("w1", "web_search", { query: "anything" }),
      call("t1", "ToolSearch", { query: "select:web_search" }),
      text("noted"),
    ]);
    await h.turn();

    const webResult = toolResultFor(h.events, "w1");
    expect(webResult.isError).toBe(true);
    expect(webResult.output).toBe("tool web_search is not available in this session");
    expect(webResult.output).not.toContain("is deferred"); // the old advisory that drove the loop

    const tsResult = toolResultFor(h.events, "t1");
    expect(tsResult.isError).toBeFalsy();
    expect(tsResult.output).toContain('no deferred tools matched "select:web_search"');
  });
});
