import { describe, test, expect, spyOn } from "bun:test";
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

  // --- final re-review must-fix: the ORIGINAL FIX 1 redirected the raw detail to console.error and
  // called it done — but stderr is NOT operator-only. launchd.ts redirects the daemon's stderr to
  // ~/.norma/logs/core.err.log, and that directory is deliberately agent-readable (daemon.ts denies
  // only dirs.runDir to the read/grep tools), so the raw key would still land somewhere Norma's own
  // tools can open it. The key must be redacted out of the line actually written to stderr. Drives
  // the REAL global fetch (no fetchFn override) — same header-validation TypeError as the test
  // above, this time asserting on what console.error was called with. Uses a short, obviously-fake
  // token (not a realistic-looking secret) and asserts on absence, per this task's own constraint
  // against training eyes to accept key-shaped strings in CI logs.
  test("the key is redacted from the console.error line too — a useful diagnostic survives", async () => {
    const r = new ToolRegistry();
    const fakeToken = "tok-b1-zwsp​"; // trailing U+200B, same artifact as the test above
    registerSearchTool(r, { secret: async () => fakeToken });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await r.execute("Search", { query: "x" }, ctx());
      const stderrText = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(stderrText).not.toContain(fakeToken);
      expect(stderrText).not.toContain("tok-b1");
      // Still diagnostic: an operator can tell this is an invalid-header failure, not a DNS one.
      expect(stderrText).toContain("invalid value");
      expect(stderrText).toContain("<redacted>");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a genuine network failure (key never appears in the underlying message) keeps its real diagnostic in stderr — redaction is a no-op, not a blanket scrub", async () => {
    const r = new ToolRegistry();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      registerSearchTool(r, {
        secret: async () => "clean-ascii-key",
        fetchFn: (async () => {
          throw new Error("getaddrinfo ENOTFOUND api.exa.ai");
        }) as unknown as typeof fetch,
      });
      await r.execute("Search", { query: "x" }, ctx());
      const stderrText = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(stderrText).toContain("ENOTFOUND");
    } finally {
      errSpy.mockRestore();
    }
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

// --- Critical 1 fold-in, whole-branch review (USER-REVISED design, 2026-07-28): "the user also
// asked that dangerous URLs never even be shown to the model" — a half-measure of blocking the READ
// (ReadPage/FetchPage) while still ADVERTISING the link would just have the model try, fail, and
// possibly retry. Strip any Exa result whose url matches the effective dangerous-domain list before
// rendering, and say how many were withheld (never a silent drop — that would misrepresent the
// result count). Reuses page-core.ts's checkDangerousDomain — not a second matcher. -----------------
describe("Search: dangerous-domain results are withheld before the model ever sees them (Critical 1 fold-in)", () => {
  const dangerousBody = {
    results: [
      { title: "Exa Pricing", url: "https://exa.ai/pricing", text: "Free tier includes $10 of credits." },
      { title: "Suspicious paste", url: "https://transfer.sh/abc123", text: "some exfiltrated-looking content" },
      { title: "Exa Docs", url: "https://docs.exa.ai", text: "Search and contents in one request." },
    ],
  };

  function setupWithDangerous(over: { added?: (cwd?: string) => string[] | undefined } = {}) {
    const r = new ToolRegistry();
    const audits: Record<string, unknown>[] = [];
    registerSearchTool(r, {
      audit: (l) => audits.push(l),
      secret: async () => "exa_test_key",
      fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(dangerousBody), { status: 200 })) as typeof fetch,
      dangerousDomainsAdded: over.added,
    });
    return { r, audits };
  }

  test("a SHIPPED dangerous host (transfer.sh) in the result set is withheld; the other results still render, and the output says how many were withheld", async () => {
    const { r } = setupWithDangerous();
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.output).toContain("https://exa.ai/pricing");
    expect(out.output).toContain("https://docs.exa.ai");
    expect(out.output).not.toContain("transfer.sh");
    expect(out.output.toLowerCase()).toContain("withheld");
    expect(out.output).toContain("1"); // exactly one withheld
  });

  test("a USER-ADDED domain is withheld exactly like a shipped one", async () => {
    const dangerousBodyCustom = {
      results: [
        { title: "OK", url: "https://exa.ai/pricing", text: "fine" },
        { title: "Custom exfil", url: "https://my-internal-exfil.example/x", text: "bad" },
      ],
    };
    const r = new ToolRegistry();
    registerSearchTool(r, {
      secret: async () => "exa_test_key",
      fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(dangerousBodyCustom), { status: 200 })) as typeof fetch,
      dangerousDomainsAdded: (cwd) => (cwd === "/tmp" ? ["my-internal-exfil.example"] : undefined),
    });
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(out.output).toContain("exa.ai/pricing");
    expect(out.output).not.toContain("my-internal-exfil.example");
    expect(out.output.toLowerCase()).toContain("withheld");
  });

  test("when EVERY result is dangerous, the response still succeeds (isError:false) and says all were withheld — never a silent empty success", async () => {
    const allDangerousBody = { results: [{ title: "bad", url: "https://transfer.sh/x", text: "bad" }] };
    const r = new ToolRegistry();
    registerSearchTool(r, {
      secret: async () => "exa_test_key",
      fetchFn: (async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(allDangerousBody), { status: 200 })) as typeof fetch,
    });
    const out = await r.execute("Search", { query: "x" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.output.toLowerCase()).toContain("withheld");
  });

  test("no dangerous results in the set: output is byte-identical to before this fix (no withheld note at all)", async () => {
    const { r } = setup();
    const out = await r.execute("Search", { query: "exa pricing" }, ctx());
    expect(out.output.toLowerCase()).not.toContain("withheld");
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
