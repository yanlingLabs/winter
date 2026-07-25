import { describe, test, expect } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerSearchTool, EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
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
 * B1-T5: Search — chat's Exa-backed web search. The whole reason chat uses Exa rather than code's
 * Brave two-step (web_search + web_fetch) is that Exa returns page excerpts ALONGSIDE the results
 * in a single POST to /search (verified live against docs.exa.ai — see task-5-report.md for the
 * full verification transcript: endpoint, auth header, `contents.text.maxCharacters` request
 * shape, and response field names all match what's exercised below).
 */

const okBody = {
  results: [
    { title: "Exa Pricing", url: "https://exa.ai/pricing", text: "Free tier includes $10 of credits." },
    { title: "Exa Docs", url: "https://docs.exa.ai", text: "Search and contents in one request." },
  ],
};

function ctx(): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s1" };
}

function setup(over: { secret?: string | null; fetchFn?: typeof fetch } = {}) {
  const r = new ToolRegistry();
  const audits: Record<string, unknown>[] = [];
  registerSearchTool(r, {
    audit: (l) => audits.push(l),
    secret: async () => (over.secret === undefined ? "exa_test_key" : over.secret),
    fetchFn: over.fetchFn ?? ((async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch),
  });
  return { r, audits };
}

describe("Search (Exa)", () => {
  test("is NOT deferred — chat has no ToolSearch, so a deferred Search would be dead (bug #7)", () => {
    const { r } = setup();
    // Regression guard: Slice A's probes found DISPATCH_ALLOW_TOOLS advertises web_fetch/web_search
    // while omitting ToolSearch, making them permanently unloadable. Do not repeat it here.
    expect(r.isDeferredBuiltin("Search", true)).toBe(false);
  });

  test("returns numbered results with title, url and an excerpt", async () => {
    const { r } = setup();
    const out = await r.execute("Search", { query: "exa pricing" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.output).toContain("1.");
    expect(out.output).toContain("https://exa.ai/pricing");
    expect(out.output).toContain("Free tier includes");
  });

  test("without a stored key it fails with an actionable message and audits no_key", async () => {
    const { r, audits } = setup({ secret: null });
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("norma login --exa-key");
    expect(audits.at(-1)).toMatchObject({ tool: "Search", outcome: "no_key" });
  });

  test("an HTTP error audits http_error and does not leak the key", async () => {
    const { r, audits } = setup({ fetchFn: (async (_url: string, _init?: RequestInit) => new Response("nope", { status: 500 })) as typeof fetch });
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).not.toContain("exa_test_key");
    expect(audits.at(-1)).toMatchObject({ outcome: "http_error" });
  });

  test("output is capped even when the API returns huge text", async () => {
    const huge = { results: Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`, url: `https://e.com/${i}`, text: "x".repeat(200_000) })) };
    const { r } = setup({ fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(huge), { status: 200 })) as typeof fetch });
    const out = await r.execute("Search", { query: "x" }, ctx());
    // Chat has no `read` tool — there is no save-to-file escape hatch, so the cap is a
    // correctness constraint, not just a safety one.
    expect(out.output.length).toBeLessThan(40_000);
  });

  test("the key never appears in the audit line", async () => {
    const { r, audits } = setup();
    await r.execute("Search", { query: "x" }, ctx());
    expect(JSON.stringify(audits)).not.toContain("exa_test_key");
  });

  test("EXA_API_KEY_SECRET is the exported keychain-secret name Search and `norma login --exa-key` share", () => {
    expect(EXA_API_KEY_SECRET).toBe("exa-api-key");
  });

  // --- FIX 6: day-one no-key UX --------------------------------------------------------------
  test("description mentions the key requirement, so the model doesn't hedge then burn a round discovering no_key (mirrors web_search's description)", () => {
    const { r } = setup();
    const spec = r.specs(null).find((s) => s.name === "Search");
    expect(spec?.description).toContain("norma login --exa-key");
  });

  test("the no-key message is the command that ACTUALLY works — no <key> placeholder (the CLI ignores a positional value and prompts instead)", async () => {
    const { r } = setup({ secret: null });
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(out.output).toBe("Search needs an API key — store one with: norma login --exa-key (from exa.ai)");
  });

  // --- FIX 1: the Exa key must never reach the tool result (branch review, Important/security) ---
  test("a stray U+200B in the key never leaks into the tool result, through Bun's REAL fetch (not an injected fake) — the header-validation leak", async () => {
    const r = new ToolRegistry();
    const audits: Record<string, unknown>[] = [];
    // U+200B (zero-width space) is the most common copy-paste artifact from a web page; .trim()
    // does NOT strip it (Unicode category Cf, not whitespace). No fetchFn override below — this
    // drives the REAL global fetch, whose header validation throws with the header's VALUE
    // embedded verbatim (confirmed live: `Header 'x-api-key' has invalid value: '...'`) BEFORE any
    // byte reaches the network (a local TypeError from header construction, not a connection).
    const leakyKey = "SUPER_SECRET_EXA_KEY​";
    registerSearchTool(r, { audit: (l) => audits.push(l), secret: async () => leakyKey });
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).not.toContain(leakyKey);
    expect(out.output).not.toContain("SUPER_SECRET_EXA_KEY");
    expect(JSON.stringify(audits)).not.toContain(leakyKey);
  });

  // --- FIX 4: redirects must not carry the key to a second, uncontrolled origin ----------------
  test("fetch is called with redirect: 'manual' — a 3xx response is treated as http_error, never auto-followed with the key attached", async () => {
    let capturedInit: RequestInit | undefined;
    const { r } = setup({
      fetchFn: (async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
      }) as typeof fetch,
    });
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(capturedInit?.redirect).toBe("manual");
    expect(out.isError).toBe(true);
    expect(out.output).toBe("search failed: HTTP 302");
  });

  // --- FIX 5: malformed response shapes must not mislabel the audit outcome -------------------
  describe("malformed response shapes are parse_error, never a mislabeled ok/network_error with leaked TypeError text", () => {
    test('results as a non-array string ("str") -> parse_error, not ok', async () => {
      const { r, audits } = setup({ fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ results: "str" }), { status: 200 })) as typeof fetch });
      const out = await r.execute("Search", { query: "x" }, ctx());
      expect(out.isError).toBe(true);
      expect(audits.at(-1)).toMatchObject({ outcome: "parse_error" });
      expect(out.output).not.toContain("is not a function");
    });

    test("results as a plain object ({}) -> parse_error, not network_error", async () => {
      const { r, audits } = setup({ fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ results: {} }), { status: 200 })) as typeof fetch });
      const out = await r.execute("Search", { query: "x" }, ctx());
      expect(out.isError).toBe(true);
      expect(audits.at(-1)).toMatchObject({ outcome: "parse_error" });
      expect(out.output).not.toContain("slice is not a function");
    });

    test("results array containing null ([null]) -> parse_error, not ok", async () => {
      const { r, audits } = setup({ fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ results: [null] }), { status: 200 })) as typeof fetch });
      const out = await r.execute("Search", { query: "x" }, ctx());
      expect(out.isError).toBe(true);
      expect(audits.at(-1)).toMatchObject({ outcome: "parse_error" });
      expect(out.output).not.toContain("Cannot read properties");
    });
  });
});

// --- gate.ts classification, exercised end to end through the real engine -----------------------
//
// Task 3's AskQuestion went in gate.ts's READ_ONLY class; this task deliberately does NOT copy
// that — Search performs real network egress, the same risk shape as web_fetch/web_search, so it
// joins gate.ts's NETWORK class instead (see gate.ts's own doc comment on that decision). NETWORK
// is unconditionally "allow" at every policy, so the practical effect for chat's `auto` default is
// identical to READ_ONLY — but the classification's OWN test lives in gate.test.ts; what belongs
// here is proof the tool actually completes in a real chat turn under `auto`, rather than carding
// for approval and stalling on a human decision that never arrives (which is exactly what an
// unclassified tool name would do — gate.ts's fail-closed "ask" branch — and which a unit test
// against the tool in isolation, above, could never catch: registry.execute() bypasses the gate
// entirely).
function setupEngine(script: ProviderEvent[][]) {
  const home = mkdtempSync(join(tmpdir(), "norma-cm-search-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cm-search-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerAskQuestionTool(registry);
  registerSearchTool(registry, {
    secret: async () => "exa_test_key",
    fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
  });

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-cm-search-actx-"));
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
    approvalTimeoutMs: 500, // would time out (and deny) a stuck approval rather than hang the test
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: "chat" });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, sessionId, provider, events };
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

describe("Search's gate.ts classification actually lets it run in chat", () => {
  test("a real chat turn under the default `auto` policy runs Search straight through — no approval card, no timeout-driven denial", async () => {
    const { engine, sessionId, events } = setupEngine([
      call("srch1", "Search", { query: "exa pricing" }),
      text("done"),
    ]);

    await engine.runTurn(sessionId);

    // The unclassified/fail-closed path would emit approval_requested and, with nobody resolving
    // it, time out into a denial — this asserts NEITHER happened.
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = toolResultFor(events, "srch1");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("https://exa.ai/pricing");
  });

  test("Search is offered in a chat turn's tool list", async () => {
    const { engine, sessionId, provider } = setupEngine([text("hello")]);
    await engine.runTurn(sessionId);
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain("Search");
  });
});
