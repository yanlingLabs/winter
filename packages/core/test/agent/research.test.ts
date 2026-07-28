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
import { registerReadPageTool, READPAGE_PER_PAGE_CHAR_CAP, READPAGE_TOTAL_OUTPUT_CHAR_CAP } from "../../src/agent/tools/read-page";
import { fetchCleanPage, PageCache } from "../../src/agent/tools/page-core";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
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

/** A provider whose streamTurn yields ONE tool_call and then the generator just ends — no `done`
 *  event ever, matching the "ambiguous stream end with pending tool_calls" scenario (Minor 3). */
class AbruptEndProvider implements Provider {
  readonly id = "abrupt";
  readonly requests: TurnRequest[] = [];
  models() { return [{ id: "abrupt-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    yield { type: "tool_call", callId: "z1", name: "FetchPage", argsJson: JSON.stringify({ urls: ["https://example.com/x"] }) };
    // generator ends here — no "done" event ever emitted.
  }
}

/** A provider whose generator has a real `finally` block — proves Minor 5's iterator-close fix:
 *  without it, `closed` stays false even after `runner.run()` resolves, because the runner never
 *  calls `.next()` again after seeing "done" (the ordinary `for await` loop the engine itself uses
 *  gets this for free; this hand-rolled loop does not, unless it explicitly calls `.return()`). */
class FinallyTrackingProvider implements Provider {
  readonly id = "finally-tracker";
  readonly requests: TurnRequest[] = [];
  closed = false;
  models() { return [{ id: "ft-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    try {
      yield { type: "text_delta", delta: "hi" };
      yield { type: "done", stopReason: "end_turn" };
    } finally {
      this.closed = true;
    }
  }
}

/** A fetchFn that never settles under ANY circumstance — ignores its signal entirely, just like
 *  StallingProvider does for the provider side. Proves research.ts's OWN explicit race
 *  (`raceDeadline`) is what bounds a hung fetch, independent of whether the fetch would ever
 *  cooperate with an AbortSignal (page-core.ts's own signal-based default timeout is a SEPARATE,
 *  slower backstop — 15s by default — that a maximally adversarial double like this would defeat
 *  on its own; research.ts must not depend on it alone). */
const neverResolvingFetch: typeof fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;

function ctx(): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s1" };
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

// --- Critical 1, whole-branch review (USER-REVISED design, 2026-07-28): FetchPage cannot card (it
// is "not interactive" — the sub-agent has no human in the loop at all), so a dangerous-domain url
// is HARD-REFUSED with a clear message that lands in the report, and the run continues with its
// other pages. Reuses page-core.ts's `checkDangerousDomain` — NOT a second matcher. --------------
describe("research.ts: dangerous-domain hard-block (Critical 1 fix — FetchPage cannot card, so it hard-refuses)", () => {
  test("a dangerous url inside a FetchPage batch is refused with a clear message; the safe sibling in the SAME batch still succeeds, and the run completes normally", async () => {
    const { fetchFn } = urlFetch({
      [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
      "https://example.com/a": { status: 200, body: pageHtml("Page A"), contentType: "text/html" },
      // deliberately NO entry for transfer.sh — if the hard-block failed to stop the fetch, urlFetch
      // itself would throw "no scripted response for..." instead of the dangerous-domain message,
      // which would fail this test's own assertions below and so double as proof the network was
      // never reached.
    });
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls: ["https://example.com/a", "https://transfer.sh/x"] }),
      text(`final report. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    const report = await runner.run({ url: SEED_URL, query: "q", max_pages: 5 }, {});

    const round1Result = toolResultsOf(provider.requests[1]!.input).find((r) => r.callId === "f1");
    expect(round1Result?.isError).toBe(false); // informational, never a hard tool error (matches the batch's own precedent)
    expect(round1Result?.output).toContain("Page A"); // the safe sibling succeeded
    expect(round1Result?.output).toContain("transfer.sh/x");
    expect(round1Result?.output).toContain("transfer.sh"); // names the matched entry
    expect(round1Result?.output.toLowerCase()).toContain("dangerous");
    expect(report).toBe("final report. https://example.com/ lines:1-3"); // the run completed normally, not aborted
  });

  test("the SEED url itself being dangerous refuses before the sub-agent does anything (defense in depth — ReadPage's own hard-block already covers the normal path), never reaching the network", async () => {
    // NO scripted response for transfer.sh — if the hard-block failed to fire before the seed
    // fetch, urlFetch would throw "no scripted response for..." instead, which would NOT match the
    // dangerous-domain message this asserts on (proving the network was never reached).
    const { fetchFn } = urlFetch({});
    const runner = createResearchRunner({ provider: new FakeProvider([]), cache: new PageCache(), fetchFn });
    await expect(runner.run({ url: "https://transfer.sh/seed", query: "q" }, {})).rejects.toThrow(/dangerous-domain/i);
  });

  test("a USER-ADDED domain (threaded via ReadPage's own ctx.cwd -> ResearchQuery.cwd) is blocked exactly like a shipped one", async () => {
    const { fetchFn } = urlFetch({
      [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
    });
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls: ["https://my-internal-exfil.example/x"] }),
      text(`final. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({
      provider, cache: new PageCache(), fetchFn,
      dangerousDomainsAdded: (cwd) => (cwd === "/tmp" ? ["my-internal-exfil.example"] : undefined),
    });

    await runner.run({ url: SEED_URL, query: "q", max_pages: 5, cwd: "/tmp" }, {});

    const round1Result = toolResultsOf(provider.requests[1]!.input).find((r) => r.callId === "f1");
    expect(round1Result?.output).toContain("my-internal-exfil.example");
    expect(round1Result?.output.toLowerCase()).toContain("dangerous");
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

  test("a second bad_request after the fallback was already used does NOT retry again — the run REJECTS with an honest failure (fix-round-1 Minor 4: a failed run is isError:true, not a success-shaped string)", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      [{ type: "error", code: "bad_request", message: `unknown model: ${RESEARCH_MODEL}` }],
      [{ type: "error", code: "bad_request", message: `unknown model: ${RESEARCH_FALLBACK_MODEL}` }],
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await expect(runner.run({ url: SEED_URL, query: "q" }, {})).rejects.toThrow(/bad_request/);
    expect(provider.requests.length).toBe(2); // no third attempt
  });

  test("a non-model error (rate_limit) never retries — the run REJECTS (fix-round-1 Minor 4), never a resolved failure-shaped string", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      [{ type: "error", code: "rate_limit", message: "slow down" }],
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await expect(runner.run({ url: SEED_URL, query: "q" }, {})).rejects.toThrow(/rate_limit/);
    expect(provider.requests.length).toBe(1); // no retry
  });

  test("a context_length_exceeded bad_request (naming the model too) does NOT burn the fallback — fix-round-1 Minor 1", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      [{ type: "error", code: "bad_request", message: `context_length_exceeded: ${RESEARCH_MODEL}'s maximum context length is 128000 tokens` }],
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await expect(runner.run({ url: SEED_URL, query: "q" }, {})).rejects.toThrow(/context_length_exceeded/);
    expect(provider.requests.length).toBe(1); // no retry — the fallback model can't fix a payload-size problem either
  });

  test("an auth error that merely happens to mention the model slug does NOT retry — fix-round-1 Minor 1", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([
      [{ type: "error", code: "auth", message: `invalid api key for ${RESEARCH_MODEL}` }],
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await expect(runner.run({ url: SEED_URL, query: "q" }, {})).rejects.toThrow(/invalid api key/);
    expect(provider.requests.length).toBe(1); // no retry — naming the model isn't evidence of a model problem under an auth error
  });

  test("a provider error preserves an EARLIER round's own assistant text in the failure — fix-round-1 Minor 2 (a partial answer beats none)", async () => {
    const { fetchFn } = urlFetch({
      [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
      "https://example.com/a": { status: 200, body: pageHtml("Page A"), contentType: "text/html" },
    });
    const provider = new FakeProvider([
      [
        { type: "text_delta", delta: "partial analysis so far." },
        { type: "tool_call", callId: "f1", name: "FetchPage", argsJson: JSON.stringify({ urls: ["https://example.com/a"] }) },
        done("tool_calls"),
      ],
      [{ type: "error", code: "rate_limit", message: "slow down" }],
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await expect(runner.run({ url: SEED_URL, query: "q" }, {})).rejects.toThrow(/partial analysis so far\./);
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

// --- Important 3, whole-branch review: same freshness signal ReadPage's own header now carries —
// the sub-agent's context deserves the same "was this cached or fresh?" signal the main model gets.
// --- Important 3, whole-branch review: the sub-agent's own fetches must be tagged "research" in the
// SHARED PageCache (not "user", the default) — otherwise the reserved-byte-share eviction (page-
// core.ts's own PageCache fix) would never actually apply to them, and a research run could still
// evict the user's own recently-read pages. Same cache instance throughout (never a separate one —
// the citation contract depends on ReadPage hitting the entry the sub-agent populated). -------------
describe("research.ts: fetches are tagged 'research' in the shared cache — a research run cannot evict the user's own cached page (Important 3 fix)", () => {
  test("a user's directly-cached page survives a research run that reads many OTHER (larger) pages, via the SAME PageCache instance, under a TIGHT overall budget", async () => {
    // Tight enough that 8 research-sized pages alone (~200+ bytes each, ~1.6KB total) plus the
    // user's own small page comfortably exceeds the WHOLE budget — if research fetches were still
    // tagged "user" (the pre-fix default), the oldest entry (the user's, inserted first) would be
    // the first thing pass-2's ordinary oldest-first eviction reclaims once that combined total blew
    // past maxBytes. With research properly tagged, its own reserved half-share absorbs that
    // pressure among ITS OWN entries and the user's entry is never touched.
    const cache = new PageCache({ maxBytes: 1000, researchByteShare: 0.5 });
    // The user's own page, put directly (mirrors what a plain ReadPage fetch does — origin "user"),
    // BEFORE the research run — the oldest entry in the cache, and so the FIRST thing an untagged,
    // purely-oldest-first eviction would reclaim.
    await fetchCleanPage("https://user-important.example/", cache, {
      fetchFn: urlFetch({ "https://user-important.example/": { status: 200, body: pageHtml("User Page"), contentType: "text/html" } }).fetchFn,
    });

    const responses: Record<string, Step> = { [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } };
    const urls = Array.from({ length: 8 }, (_, i) => `https://research${i}.example.com/`);
    for (const u of urls) {
      responses[u] = {
        status: 200,
        contentType: "text/html",
        body: pageHtml(`Research page ${u} padded with a good deal of extra filler text so each one weighs a meaningful number of bytes on its own.`),
      };
    }
    const { fetchFn } = urlFetch(responses);
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls }),
      text(`final. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache, fetchFn });

    await runner.run({ url: SEED_URL, query: "q", max_pages: 10 }, {});

    // The user's page must STILL be in cache — a research run, however large, must never evict it.
    const stillCached = await fetchCleanPage("https://user-important.example/", cache, {
      fetchFn: (async () => { throw new Error("must not refetch — should have hit cache"); }) as unknown as typeof fetch,
    });
    expect(stillCached.fromCache).toBe(true);
  });
});

describe("research.ts: freshness signal in the sub-agent's own page sections (Important 3 fix)", () => {
  test("the seed page section (in the first provider request) states it was a fresh fetch", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([text(`report. ${SEED_URL} lines:1-3`)]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "q" }, {});

    const seedMessage = provider.requests[0]!.input.find((i) => i.type === "message" && i.role === "user");
    const seedText = seedMessage && seedMessage.type === "message" ? String(seedMessage.content) : "";
    expect(seedText.toLowerCase()).toContain("fresh fetch");
  });

  test("a FetchPage batch entry served from cache states it was cached", async () => {
    const { fetchFn } = urlFetch({
      [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
      "https://example.com/a": { status: 200, body: pageHtml("Page A"), contentType: "text/html" },
    });
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls: ["https://example.com/a"] }),
      toolCall("f2", "FetchPage", { urls: ["https://example.com/a"] }), // same url again -> cache hit
      text(`final. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "q", max_pages: 10 }, {});

    const round2Result = toolResultsOf(provider.requests[2]!.input).find((r) => r.callId === "f2");
    expect(round2Result?.output.toLowerCase()).toContain("cached");
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

describe("research.ts: an empty or ambiguous stream never reports success (fix-round-1 Minor 3)", () => {
  test("[done end_turn] with no text at all fails honestly rather than returning an empty report as success", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([[done("end_turn")]]); // no text_delta at all
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await expect(runner.run({ url: SEED_URL, query: "q" }, {})).rejects.toThrow(/no report was produced/);
  });

  test("a stream that ends abruptly with a pending tool_call and no done event fails honestly instead of silently dropping the call", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new AbruptEndProvider();
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await expect(runner.run({ url: SEED_URL, query: "q" }, {})).rejects.toThrow(/ended unexpectedly.*1 tool call/);
  });
});

describe("research.ts: a failed run surfaces as isError:true through ReadPage, never isError:false (fix-round-1 Minor 4)", () => {
  test("a non-retryable provider error, run through registerReadPageTool's query entry, is an isError:true tool result", async () => {
    const cache = new PageCache();
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FakeProvider([[{ type: "error", code: "rate_limit", message: "slow down" }]]);
    const runner = createResearchRunner({ provider, cache, fetchFn });
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache, research: runner });

    const out = await r.execute("ReadPage", { pages: [{ url: SEED_URL, query: "q" }] }, ctx());

    expect(out.isError).toBe(true);
    expect(out.output.toLowerCase()).toContain("rate_limit");
  });
});

describe("research.ts: closes the round's provider iterator (fix-round-1 Minor 5)", () => {
  test("a generator's own `finally` block runs even though the runner never calls next() again after seeing 'done'", async () => {
    const { fetchFn } = urlFetch({ [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } });
    const provider = new FinallyTrackingProvider();
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "q" }, {});

    expect(provider.closed).toBe(true);
  });
});

describe("research.ts: the wall clock also bounds FETCHES, not just the provider stream (fix-round-1 CRITICAL)", () => {
  test("a hanging SEED-page fetch resolves via the wall clock, with a partial report stating it timed out — nothing hangs", async () => {
    const provider = new FakeProvider([text("unreachable")]); // never actually reached
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn: neverResolvingFetch, wallClockMs: 50 });

    const start = Date.now();
    const report = await runner.run({ url: SEED_URL, query: "q" }, {});
    expect(Date.now() - start).toBeLessThan(1500);
    expect(report.toLowerCase()).toContain("timed out");
  });

  // fix-round-2 (optional consistency fix, reviewer's nit): a wall-clock expiry that reaches the
  // seed fetch via a COOPERATIVE fetchFn (one that actually honors AbortSignal, unlike
  // `neverResolvingFetch` above) surfaces as a REJECTION from fetchCleanPage (a PageCoreError with
  // outcome:"timeout") — Promise.race settles the instant ANY raced promise settles, and that
  // abort-driven rejection's own timer was registered earlier than raceDeadline's separate one, so
  // it reliably wins. Before this fix, the seed path's catch unconditionally re-threw that as a
  // hard failure (reject), while the analogous per-URL case in the BATCH path (handleFetchPage)
  // just logs a "not read" line and the run continues/resolves — same class of expiry, two
  // different shapes. Both outcomes are bounded and honest either way (nothing lost at the seed —
  // zero pages had been read yet), so this is cosmetic, not a correctness bug — fixed for
  // consistency since the seed-specific `PageCoreError`/`outcome==="timeout"` check was one small,
  // self-contained addition.
  test("a wall-clock expiry reaching the seed fetch via a COOPERATIVE fetchFn also RESOLVES with a partial report — consistent with the batch path, not a reject", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const abort = () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof fetch;
    const provider = new FakeProvider([text("unreachable")]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn, wallClockMs: 50 });

    const start = Date.now();
    const report = await runner.run({ url: SEED_URL, query: "q" }, {});
    expect(Date.now() - start).toBeLessThan(1500);
    expect(report.toLowerCase()).toContain("timed out");
  });

  test("a hanging FetchPage-BATCH fetch resolves via the wall clock too", async () => {
    const fetchFn = (async (url: string | URL) => {
      if (String(url) === SEED_URL) {
        return new Response(FIVE_LINE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Promise<Response>(() => {}); // hangs forever for any other url, ignoring signal
    }) as unknown as typeof fetch;
    const provider = new FakeProvider([toolCall("f1", "FetchPage", { urls: ["https://example.com/a"] })]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn, wallClockMs: 80 });

    const start = Date.now();
    const report = await runner.run({ url: SEED_URL, query: "q" }, {});
    expect(Date.now() - start).toBeLessThan(1500);
    expect(report.toLowerCase()).toContain("timed out");
  });

  test("the same guarantee holds calling through registerReadPageTool's query entry, not just the raw runner directly", async () => {
    const cache = new PageCache();
    const provider = new FakeProvider([]); // never actually gets to speak
    const runner = createResearchRunner({ provider, cache, fetchFn: neverResolvingFetch, wallClockMs: 50 });
    const r = new ToolRegistry();
    registerReadPageTool(r, { cache, research: runner });

    const start = Date.now();
    const out = await r.execute("ReadPage", { pages: [{ url: SEED_URL, query: "q" }] }, ctx());
    expect(Date.now() - start).toBeLessThan(1500);
    expect(out.output.toLowerCase()).toContain("timed out");
  });
});

describe("research.ts: the sub-agent's OWN context is capped too, not just the final report (fix-round-1 IMPORTANT)", () => {
  test("a single huge fetched page is capped at READPAGE_PER_PAGE_CHAR_CAP inside the sub-agent's context, and says content was cut", async () => {
    const hugeHtml = `<html><head><title>Huge</title></head><body><p>${"x".repeat(400_000)}</p></body></html>`;
    const { fetchFn } = urlFetch({
      [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" },
      "https://example.com/huge": { status: 200, body: hugeHtml, contentType: "text/html" },
    });
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls: ["https://example.com/huge"] }),
      text(`final. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "q" }, {});

    const f1Result = toolResultsOf(provider.requests[1]!.input).find((r) => r.callId === "f1");
    expect(f1Result!.output.length).toBeLessThanOrEqual(READPAGE_PER_PAGE_CHAR_CAP + 100);
    expect(f1Result!.output.toLowerCase()).toContain("cut");
  });

  test("8 huge pages batched in ONE FetchPage call stay bounded at READPAGE_TOTAL_OUTPUT_CHAR_CAP — not the 2.4M-char blowup the reviewer measured", async () => {
    const hugeHtml = `<html><head><title>Huge</title></head><body><p>${"x".repeat(300_000)}</p></body></html>`;
    const urls = Array.from({ length: 8 }, (_, i) => `https://example.com/huge${i}`);
    const responses: Record<string, Step> = { [SEED_URL]: { status: 200, body: FIVE_LINE_HTML, contentType: "text/html" } };
    for (const u of urls) responses[u] = { status: 200, body: hugeHtml, contentType: "text/html" };
    const { fetchFn } = urlFetch(responses);
    const provider = new FakeProvider([
      toolCall("f1", "FetchPage", { urls }),
      text(`final. ${SEED_URL} lines:1-3`),
    ]);
    const runner = createResearchRunner({ provider, cache: new PageCache(), fetchFn });

    await runner.run({ url: SEED_URL, query: "q", max_pages: 15 }, {});

    const f1Result = toolResultsOf(provider.requests[1]!.input).find((r) => r.callId === "f1");
    expect(f1Result!.output.length).toBeLessThanOrEqual(READPAGE_TOTAL_OUTPUT_CHAR_CAP + 200);
    expect(f1Result!.output.toLowerCase()).toContain("truncated");
    expect(f1Result!.output.toLowerCase()).toContain("cut");
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
