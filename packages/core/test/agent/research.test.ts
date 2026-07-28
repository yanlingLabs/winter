import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import {
  createResearchRunner,
  RESEARCH_MODEL,
  RESEARCH_FALLBACK_MODEL,
  RESEARCH_EFFORT,
  RESEARCH_MAX_PAGES_DEFAULT,
  RESEARCH_MAX_PAGES_CEILING,
} from "../../src/agent/research";
import { registerReadPageTool } from "../../src/agent/tools/read-page";
import { fetchCleanPage, PageCache } from "../../src/agent/tools/page-core";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { BackgroundAgentRegistry } from "../../src/agent/bg-agent-registry";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { Provider, ProviderEvent, TurnRequest, TurnInputItem } from "../../src/providers/types";

/**
 * B2-T3: the ephemeral research sub-agent — see task-3-brief.md + task-3-report.md.
 *
 * Everything here uses a scripted FakeProvider and an injected fetchFn: zero live network/model
 * calls. The ephemerality tests below assert against the REAL SessionStore/SessionHub/
 * BackgroundAgentRegistry instances a production harness would hand the runner — not "the design
 * says so" — because that is a hard, user-decided boundary this file exists to prove.
 */

interface Step { status: number; body?: string; contentType?: string }

/** Dispatches by exact requested URL — matches read-page.test.ts's own helper of the same name. */
function urlFetch(responses: Record<string, Step>): { fetchFn: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchFn = (async (url: string | URL) => {
    calls++;
    const key = String(url);
    const step = responses[key];
    if (!step) throw new Error(`no scripted response for ${key}`);
    const headers = new Headers();
    if (step.contentType) headers.set("content-type", step.contentType);
    return new Response(step.body ?? "", { status: step.status, headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

function pageHtml(title: string, links: string[] = []): string {
  const linkTags = links.map((href) => `<p><a href="${href}">${href}</a></p>`).join("");
  return `<html><head><title>${title}</title></head><body><p>${title} body text.</p>${linkTags}</body></html>`;
}

const SEED_URL = "https://example.com/";
const FIVE_LINE_HTML =
  "<html><head><title>Five Lines</title></head><body>" +
  "<p>line one</p><p>line two</p><p>line three</p><p>line four</p><p>line five</p>" +
  '<p><a href="https://example.com/a">link a</a></p><p><a href="https://example.com/b">link b</a></p>' +
  "</body></html>";

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const toolCall = (callId: string, name: string, args: unknown): ProviderEvent[] =>
  [{ type: "tool_call", callId, name, argsJson: JSON.stringify(args) }, done("tool_calls")];

function toolResultsOf(input: TurnInputItem[]): Extract<TurnInputItem, { type: "tool_result" }>[] {
  return input.filter((i): i is Extract<TurnInputItem, { type: "tool_result" }> => i.type === "tool_result");
}

/** A provider whose streamTurn genuinely never resolves and never even looks at req.signal — the
 *  only thing that can end a run against this provider is the RUNNER's own wall-clock race, not
 *  cooperative abort handling on the provider's part. That is deliberately the harder case: it
 *  proves the runner itself cannot hang, rather than merely proving a well-behaved provider
 *  happens to respect AbortSignal. */
class StallingProvider implements Provider {
  readonly id = "stall";
  readonly requests: TurnRequest[] = [];
  models() { return [{ id: "stall-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    await new Promise<void>(() => {}); // never resolves, ignores req.signal entirely
    yield { type: "done", stopReason: "end_turn" }; // unreachable — documents intent only
  }
}

describe("research.ts: the isolation pin — FetchPage is the ONLY tool the sub-agent is ever offered", () => {
  test("the provider request carries exactly one tool, FetchPage — no ReadPage, nothing else", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([text(`report. ${SEED_URL} lines:1-3`)]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "what is this page about?" }, {});

    const tools = provider.requests[0]?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["FetchPage"]);
    expect(provider.requests[0]?.model).toBe(RESEARCH_MODEL);
    expect(provider.requests[0]?.reasoningEffort).toBe(RESEARCH_EFFORT);
  });

  test("a scripted off-list tool call (bash) gets an isError tool_result and executes nothing — only FetchPage is real", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      toolCall("x1", "bash", { command: "echo hi" }),
      text(`final report. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    const report = await runner.run({ url: SEED_URL, query: "q" }, {});

    expect(report).toContain("final report");
    const round2Input = provider.requests[1]!.input;
    const result = toolResultsOf(round2Input).find((r) => r.callId === "x1");
    expect(result?.isError).toBe(true);
    expect(result?.output.toLowerCase()).toContain("only fetchpage");
  });
});

describe("research.ts: FetchPage batching", () => {
  test("a batch of 2 urls in ONE call returns both pages in ONE tool_result; the budget decrements by exactly 2", async () => {
    const { fetchFn } = urlFetch({
      [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
      "https://example.com/a": { status: 200, body: pageHtml("Page A"), contentType: "text/html" },
      "https://example.com/b": { status: 200, body: pageHtml("Page B"), contentType: "text/html" },
      "https://example.com/c": { status: 200, body: pageHtml("Page C"), contentType: "text/html" },
    });
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls: ["https://example.com/a", "https://example.com/b"] }),
      toolCall("f2", "FetchPage", { urls: ["https://example.com/c"] }),
      text(`final. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    // Budget of 3: seed(1) + the first batch's 2 urls = 3, exactly exhausted before the 3rd call.
    await runner.run({ url: SEED_URL, query: "q", max_pages: 3 }, {});

    const round1Result = toolResultsOf(provider.requests[1]!.input).find((r) => r.callId === "f1");
    expect(round1Result?.isError).toBe(false);
    expect(round1Result?.output).toContain("Page A");
    expect(round1Result?.output).toContain("Page B");

    const round2Result = toolResultsOf(provider.requests[2]!.input).find((r) => r.callId === "f2");
    expect(round2Result?.output).toBe("page budget exhausted (3 pages read)");
  });
});

describe("research.ts: page budget — clamp, default, exhaustion, and the not-read note reaching the model", () => {
  test("max_pages unset defaults to 5 — exhaustion fires on the page immediately after the 5th", async () => {
    const responses: Record<string, Step> = { [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } };
    for (let i = 1; i <= 5; i++) responses[`https://example.com/p${i}`] = { status: 200, body: pageHtml(`P${i}`), contentType: "text/html" };
    const { fetchFn } = urlFetch(responses);
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls: ["https://example.com/p1", "https://example.com/p2", "https://example.com/p3", "https://example.com/p4"] }),
      toolCall("f2", "FetchPage", { urls: ["https://example.com/p5"] }),
      text(`final. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "q" }, {}); // no max_pages — default applies

    // seed(1) + batch of 4 = 5 == RESEARCH_MAX_PAGES_DEFAULT: the very next call is exhausted.
    expect(RESEARCH_MAX_PAGES_DEFAULT).toBe(5);
    const round2Result = toolResultsOf(provider.requests[2]!.input).find((r) => r.callId === "f2");
    expect(round2Result?.output).toBe("page budget exhausted (5 pages read)");
  });

  test("max_pages clamps at the ceiling of 15 even when a huge value is requested; a batch straddling the ceiling reports exactly what it could not fetch, and that note reaches the final round's context", async () => {
    expect(RESEARCH_MAX_PAGES_CEILING).toBe(15);
    const responses: Record<string, Step> = { [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } };
    const batch1 = Array.from({ length: 8 }, (_, i) => `https://example.com/b1-${i}`);
    const batch2 = Array.from({ length: 8 }, (_, i) => `https://example.com/b2-${i}`);
    for (const u of [...batch1, ...batch2]) responses[u] = { status: 200, body: pageHtml(u), contentType: "text/html" };
    const { fetchFn } = urlFetch(responses);
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls: batch1 }), // seed(1) + 8 = 9
      toolCall("f2", "FetchPage", { urls: batch2 }), // remaining = 15-9 = 6 of the 8 requested succeed
      text(`final report naming what was skipped. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    const report = await runner.run({ url: SEED_URL, query: "q", max_pages: 999 }, {});
    expect(report).toContain("final report");

    // The final round (index 2) is what the model actually saw before writing its report — assert
    // the machinery injected the specific not-fetched urls there, not just a generic count.
    const finalRoundInput = provider.requests[2]!.input;
    const f2Result = toolResultsOf(finalRoundInput).find((r) => r.callId === "f2");
    expect(f2Result?.output).toContain("page budget exhausted (15 pages read)");
    expect(f2Result?.output).toContain(batch2[6]); // the 7th url (index 6) was NOT fetched — remaining was 6
    expect(f2Result?.output).toContain(batch2[7]); // neither was the 8th
    expect(f2Result?.output).toContain(batch2[0]); // the first 6 DID fetch — their page content is present
  });
});

describe("research.ts: wall clock — the injectable timeout, and the guarantee that a stalled provider never hangs the run", () => {
  test("a provider that stalls forever (and ignores the abort signal) still resolves with a partial report naming the timeout, well inside a real test timeout", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new StallingProvider();
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn, wallClockMs: 25 });

    const start = Date.now();
    const report = await runner.run({ url: SEED_URL, query: "q" }, {});
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000); // proves the run did not wait out the real 180_000ms default
    expect(report.toLowerCase()).toContain("timed out");
  });
});

describe("research.ts: model fallback", () => {
  test("a bad_request error naming the model triggers exactly ONE retry with RESEARCH_FALLBACK_MODEL", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      [{ type: "error", code: "bad_request", message: `unknown model: ${RESEARCH_MODEL}` }],
      text(`final report. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    const report = await runner.run({ url: SEED_URL, query: "q" }, {});

    expect(report).toContain("final report");
    expect(provider.requests.length).toBe(2);
    expect(provider.requests[0]!.model).toBe(RESEARCH_MODEL);
    expect(provider.requests[1]!.model).toBe(RESEARCH_FALLBACK_MODEL);
  });

  test("a second bad_request after the fallback was already used does NOT retry again — an honest failure report comes back instead", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      [{ type: "error", code: "bad_request", message: `unknown model: ${RESEARCH_MODEL}` }],
      [{ type: "error", code: "bad_request", message: `unknown model: ${RESEARCH_FALLBACK_MODEL}` }],
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    const report = await runner.run({ url: SEED_URL, query: "q" }, {});

    expect(provider.requests.length).toBe(2); // no third attempt
    expect(report.toLowerCase()).toContain("bad_request");
  });

  test("a non-model error (rate_limit) never retries — the run resolves (never throws) with an honest failure report", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      [{ type: "error", code: "rate_limit", message: "slow down" }],
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    const report = await runner.run({ url: SEED_URL, query: "q" }, {});

    expect(provider.requests.length).toBe(1); // no retry
    expect(report.toLowerCase()).toContain("rate_limit");
  });
});

describe("research.ts: the report contract — the system prompt DEMANDS citations, a links list, and a not-read list", () => {
  test("the instructions sent to the provider carry the citation form, the links-found requirement, and the not-read requirement", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([text(`report. ${SEED_URL} lines:1-3`)]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "what is this?" }, {});

    const instructions = (provider.requests[0]?.instructions ?? "").toLowerCase();
    expect(instructions).toContain("lines:n-m");
    expect(instructions).toContain("links found");
    expect(instructions).toContain("not read");
  });
});

describe("research.ts: audit labeling — FetchPage-driven fetches are distinguishable from ReadPage's own", () => {
  test("the runner's fetches audit tool:'FetchPage'; fetchCleanPage's own default (untouched Task 2 call sites) stays 'ReadPage'", async () => {
    const audited: Record<string, unknown>[] = [];
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([text(`report. ${SEED_URL} lines:1-3`)]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn, audit: (l) => audited.push(l) });

    await runner.run({ url: SEED_URL, query: "q" }, {});

    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((l) => l.tool === "FetchPage")).toBe(true);
    expect(audited.some((l) => l.tool === "ReadPage")).toBe(false);

    // Task 2's own call sites never pass `tool` — fetchCleanPage's default must still be "ReadPage".
    const auditedDefault: Record<string, unknown>[] = [];
    const { fetchFn: fetchFn2 } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    await fetchCleanPage(SEED_URL, new PageCache(), { fetchFn: fetchFn2, audit: (l) => auditedDefault.push(l) });
    expect(auditedDefault[0]?.tool).toBe("ReadPage");
  });
});

describe("research.ts: ephemerality — proven by inspecting the REAL stores handed to a production-shaped harness", () => {
  test("after a run: no new session in the store, no bgAgents entry, no thread_started/agent-flavoured hub events — nothing an addressing surface could find", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-research-ephemeral-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const bgAgents = new BackgroundAgentRegistry();
    const hostSessionId = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto", mode: "chat" });

    const sessionCountBefore = store.list().length;
    const bgAgentsBefore = bgAgents.list(hostSessionId).length;

    const hubEvents: SessionEvent[] = [];
    hub.attach({ clientName: "ephemerality-observer", deliver: (e) => { hubEvents.push(e); return true; } }, hostSessionId, 0);
    // `attach` itself replays the session's own history (session_created) and appends its own
    // harness_attached — neither has anything to do with the research run about to happen.
    // Baseline AFTER attach, so what matters below is "any events landed BECAUSE OF the run".
    const hubEventCountBeforeRun = hubEvents.length;

    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([text(`report. ${SEED_URL} lines:1-3`)]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    const report = await runner.run({ url: SEED_URL, query: "what is this?" }, {});
    expect(report).toContain("report");

    // 1. No transcript: no new session.
    expect(store.list().length).toBe(sessionCountBefore);
    // 2. Not addressable: no bgAgents entry for the host session (or anywhere the runner could
    //    plausibly have registered one — it was never given `hostSessionId` at all).
    expect(bgAgents.list(hostSessionId).length).toBe(bgAgentsBefore);
    // 3. No thread_started/thread_completed/child_update (or anything else) landed on the hub —
    //    the runner was never given `hub` to begin with, so this also proves nothing leaked in
    //    through some other session's hub by accident.
    expect(hubEvents.length).toBe(hubEventCountBeforeRun);
    expect(hubEvents.some((e) => e.type === "thread_started" || e.type === "thread_completed" || e.type === "child_update")).toBe(false);
  });
});

describe("research.ts: end-to-end through ReadPage — a real chat turn's query entry returns the report, not the raw page", () => {
  function harness(script: ProviderEvent[][]) {
    const home = mkdtempSync(join(tmpdir(), "norma-research-e2e-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-research-e2e-cwd-")));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const registry = new ToolRegistry();
    registerAskQuestionTool(registry);

    const cache = new PageCache();
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider(script);
    // Same Provider instance drives BOTH the main chat turn and the ephemeral sub-agent — exactly
    // daemon.ts's own wiring (agentProvider.provider shared between the engine and the research
    // runner), and the SAME PageCache too, so a later ReadPage(lineStart/lineEnd) would hit the
    // identical cache entry the report's citations point at.
    const research = createResearchRunner({ provider, cache, fetchFn });
    registerReadPageTool(registry, { cache, research, fetchFn });

    const assemblerHome = mkdtempSync(join(tmpdir(), "norma-research-e2e-actx-"));
    const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
    const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
    const broker = new ApprovalBroker();
    const dirs = new SessionDirectories(() => [cwd]);
    const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
    const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
    const engine = new AgentEngine({
      store, hub, registry, broker,
      gate: new PermissionGate(),
      provider: { provider, model: "fake-1" },
      dirs, assembler, compactor,
      approvalTimeoutMs: 500,
    });
    const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode: "chat" });
    const events: SessionEvent[] = [];
    hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
    return { engine, sessionId, provider, events };
  }

  test("ReadPage({pages:[{url,query}]}) in a real chat turn returns the sub-agent's report as the tool_result, not the raw seed page", async () => {
    const { engine, sessionId, events } = harness([
      toolCall("r1", "ReadPage", { pages: [{ url: SEED_URL, query: "what is this page about?" }] }),
      text(`the research report cited above. ${SEED_URL} lines:1-3`), // the sub-agent's own final round
      text("done"), // the main chat turn's second round, consuming ReadPage's tool_result
    ]);

    await engine.runTurn(sessionId);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "r1");
    expect(result).toBeDefined();
    if (result?.type !== "tool_result") throw new Error("expected a tool_result");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("the research report cited above");
    expect(result.output).not.toContain("1→line one"); // NOT the raw numbered seed page
  });
});
