import { describe, expect, spyOn, test } from "bun:test";
import { ToolRegistry, type ToolContext } from "../../../src/agent/tools/registry";
import { EXA_API_KEY_SECRET, registerSearchTool, searchToolDefs, type SearchToolDeps } from "../../../src/agent/tools/search";

/**
 * `Search` — Exa ANSWER mode (user ruling, 2026-09-18).
 *
 * NO LIVE NETWORK anywhere in this file: every case drives the tool through an injected `fetchFn`,
 * so what is asserted is exactly the request the tool CONSTRUCTS and exactly the string it hands the
 * model. The security assertions carried over from the `/search` era are the ones that matter most
 * here and they are all pinned below: the key rides the `x-api-key` HEADER (never the URL), it is
 * read inside `run` and nowhere else, it never reaches the tool_result, the audit line or a log
 * line, and a provider error BODY never reaches the model.
 */

const KEY = "exa_test_key_do_not_leak";

interface Call { url: string; init: RequestInit }

function harness(over: {
  respond?: (call: Call) => Response | Promise<Response>;
  key?: string | null;
  dangerousDomainsAdded?: (cwd?: string) => string[] | undefined;
} = {}): { registry: ToolRegistry; calls: Call[]; audit: Array<Record<string, unknown>>; secretCalls: string[] } {
  const calls: Call[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const secretCalls: string[] = [];
  const deps: SearchToolDeps = {
    audit: (line) => audit.push(line),
    secret: async (name) => { secretCalls.push(name); return over.key === undefined ? KEY : over.key; },
    fetchFn: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return over.respond ? await over.respond({ url: String(url), init: init ?? {} }) : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    ...(over.dangerousDomainsAdded === undefined ? {} : { dangerousDomainsAdded: over.dangerousDomainsAdded }),
  };
  const registry = new ToolRegistry();
  registerSearchTool(registry, deps);
  return { registry, calls, audit, secretCalls };
}

function ctx(): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s_search", mode: "chat" } as ToolContext;
}

function answerBody(over: Partial<{ answer: unknown; citations: unknown }> = {}): string {
  return JSON.stringify({
    requestId: "req_1",
    answer: "answer" in over ? over.answer : "Winter ships on macOS.",
    citations: "citations" in over ? over.citations : [{ title: "Winter", url: "https://example.com/winter", text: "ignored" }],
    costDollars: { total: 0.005 },
  });
}

describe("Search: the schema and the description", () => {
  test("exactly one input, `query` — the `/search` era's `max_results` went with the endpoint", () => {
    const def = searchToolDefs()[0]!;
    expect(def.name).toBe("Search");
    expect(def.modes).toEqual(["chat", "dispatch"]);
    expect(def.deferred).toBeUndefined();
    const parsed = def.args.safeParse({ query: "q", max_results: 5 });
    expect(parsed.success).toBe(true);
    // zod strips the unknown key rather than honouring it — the point is that nothing downstream
    // can read a count the tool no longer sends.
    expect(parsed.success && Object.keys(parsed.data as object)).toEqual(["query"]);
    expect(def.args.safeParse({ query: "" }).success).toBe(false);
  });

  test("the description promises an ANSWER with SOURCES, not a list of results", () => {
    const d = searchToolDefs()[0]!.description;
    expect(d).toContain("answer");
    expect(d).toContain("sources");
    expect(d).not.toContain("excerpt");
  });
});

describe("Search: the request it constructs", () => {
  test("POSTs /answer with the key in the x-api-key HEADER, `query` in the body, redirect:manual", async () => {
    const h = harness({ respond: () => new Response(answerBody(), { status: 200 }) });
    const out = await h.registry.execute("Search", { query: "does winter ship on macOS" }, ctx());
    expect(out.isError).toBe(false);
    expect(h.calls.length).toBe(1);
    const call = h.calls[0]!;
    expect(call.url).toBe("https://api.exa.ai/answer");
    // NEVER a query parameter — the whole point of the header form.
    expect(call.url).not.toContain(KEY);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(call.init.redirect).toBe("manual");
    expect(JSON.parse(String(call.init.body))).toEqual({ query: "does winter ship on macOS" });
  });

  test("the key is read INSIDE run (once), through EXA_API_KEY_SECRET — never at registration", async () => {
    const h = harness({ respond: () => new Response(answerBody(), { status: 200 }) });
    expect(h.secretCalls).toEqual([]);
    await h.registry.execute("Search", { query: "q" }, ctx());
    expect(h.secretCalls).toEqual([EXA_API_KEY_SECRET]);
  });
});

describe("Search: what the model gets back", () => {
  test("the answer, then a numbered Sources list of title + url", async () => {
    const h = harness({
      respond: () => new Response(answerBody({
        citations: [
          { title: " Winter ", url: "https://example.com/a" },
          { title: "Second", url: "https://example.com/b" },
        ],
      }), { status: 200 }),
    });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe(
      "Winter ships on macOS.\n\nSources:\n1. Winter\n   https://example.com/a\n2. Second\n   https://example.com/b",
    );
  });

  test("a citation's page `text` is never rendered — this tool asks for none and shows none", async () => {
    const h = harness({
      respond: () => new Response(JSON.stringify({
        answer: "A.",
        citations: [{ title: "T", url: "https://example.com/x", text: "THE WHOLE PAGE BODY" }],
      }), { status: 200 }),
    });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.output).not.toContain("THE WHOLE PAGE BODY");
  });

  test("an empty answer is `no answer for <query>`", async () => {
    const h = harness({ respond: () => new Response(answerBody({ answer: "   " }), { status: 200 }) });
    const out = await h.registry.execute("Search", { query: "nothing at all" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toBe("no answer for nothing at all");
    expect(h.audit[0]!["outcome"]).toBe("ok");
  });

  test("a huge answer is capped and says so — never a silent slice", async () => {
    const h = harness({ respond: () => new Response(answerBody({ answer: "x".repeat(50_000) }), { status: 200 }) });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.output.length).toBeLessThan(31_000);
    expect(out.output).toContain("[answer truncated]");
    // The sources still survive the cap — they are what makes the partial answer checkable.
    expect(out.output).toContain("https://example.com/winter");
  });
});

describe("Search: the dangerous-domain floor on CITED urls", () => {
  test("a floor-listed citation is dropped, and the withheld count is STATED", async () => {
    const h = harness({
      dangerousDomainsAdded: () => ["evil.example"],
      respond: () => new Response(answerBody({
        citations: [
          { title: "Good", url: "https://example.com/ok" },
          { title: "Bad", url: "https://evil.example/x" },
        ],
      }), { status: 200 }),
    });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).not.toContain("evil.example");
    expect(out.output).toContain("https://example.com/ok");
    expect(out.output).toContain("[1 source withheld — matched the dangerous-domain list]");
  });

  test("every citation withheld → the answer still comes back, MARKED unsourced", async () => {
    const h = harness({
      dangerousDomainsAdded: () => ["evil.example"],
      respond: () => new Response(answerBody({ citations: [{ title: "Bad", url: "https://evil.example/x" }] }), { status: 200 }),
    });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.isError).toBe(false);
    expect(out.output).toContain("Winter ships on macOS.");
    expect(out.output).toContain("[unsourced — every source was withheld by the dangerous-domain list");
    expect(out.output).toContain("[1 source withheld");
  });

  test("no citations at all → answer + an unsourced marker naming the real reason", async () => {
    const h = harness({ respond: () => new Response(answerBody({ citations: [] }), { status: 200 }) });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.output).toContain("[unsourced — the search service returned no sources");
  });
});

describe("Search: typed, non-throwing failures", () => {
  test("no key stored → an actionable message, outcome `no_key` (unreachable in a real session)", async () => {
    const h = harness({ key: null });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("winter login --exa-key");
    expect(h.calls).toEqual([]);
    expect(h.audit[0]!["outcome"]).toBe("no_key");
  });

  test.each([
    [401, "unauthorized", "winter credentials set exa"],
    [403, "unauthorized", "winter credentials set exa"],
    [402, "out_of_credits", "out of credits"],
    [429, "rate_limited", "rate-limiting"],
    [400, "http_error", "malformed"],
    [503, "http_error", "HTTP 503"],
  ] as const)("HTTP %i → outcome %s, one actionable sentence, and NEVER the provider's body", async (status, outcome, fragment) => {
    const body = `{"error":"x-api-key ${KEY} is bad","detail":"internal exa detail"}`;
    const h = harness({ respond: () => new Response(body, { status }) });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain(fragment);
    expect(out.output).not.toContain(KEY);
    expect(out.output).not.toContain("internal exa detail");
    expect(h.audit[0]!["outcome"]).toBe(outcome);
  });

  test("a 3xx is never followed — `redirect: manual` makes it an ordinary non-200", async () => {
    const h = harness({ respond: () => new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }) });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain("HTTP 302");
    expect(h.calls.length).toBe(1); // no second hop carrying the key
  });

  test("a timeout/abort → `timed out`, outcome `timeout`", async () => {
    const h = harness({
      respond: () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; },
    });
    const out = await h.registry.execute("Search", { query: "slow" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toBe("search timed out for slow");
    expect(h.audit[0]!["outcome"]).toBe("timeout");
  });

  test("a transport error never reaches the model, and the KEY is redacted out of the log line", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness({
        respond: () => { throw new Error(`Header 'x-api-key' has invalid value: '${KEY}'`); },
      });
      const out = await h.registry.execute("Search", { query: "q" }, ctx());
      expect(out.isError).toBe(true);
      expect(out.output).toBe("search failed: could not reach the search service");
      expect(out.output).not.toContain(KEY);
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("<redacted>");
      expect(logged).not.toContain(KEY);
      expect(h.audit[0]!["outcome"]).toBe("network_error");
    } finally {
      spy.mockRestore();
    }
  });

  test.each([
    ["not json at all", "could not parse response"],
    [JSON.stringify({ answer: "a", citations: "rows" }), "malformed response"],
    [JSON.stringify({ answer: "a", citations: [null] }), "malformed response"],
    [JSON.stringify({ answer: { structured: true }, citations: [] }), "malformed response"],
  ] as const)("a malformed body is `parse_error`, never a raw TypeError", async (body, fragment) => {
    const h = harness({ respond: () => new Response(body, { status: 200 }) });
    const out = await h.registry.execute("Search", { query: "q" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.output).toContain(fragment);
    expect(h.audit[0]!["outcome"]).toBe("parse_error");
  });
});

describe("Search: the audit line", () => {
  test("one line per call, every outcome, and NEVER the key", async () => {
    const h = harness({ respond: () => new Response(answerBody(), { status: 200 }) });
    await h.registry.execute("Search", { query: "who" }, ctx());
    expect(h.audit).toEqual([{ kind: "network", tool: "Search", query: "who", outcome: "ok" }]);
    expect(JSON.stringify(h.audit)).not.toContain(KEY);
  });
});

// Whole-branch review N5: THE REAL-FETCH PROOF, restored.
//
// `search.ts`'s redaction is `rawMessage.replaceAll(key, "<redacted>")`, and the reason a plain
// substring replace is SUFFICIENT is a measured fact about Bun, not a guess: Bun's own fetch embeds an
// invalid header's VALUE verbatim in its error text (`Header 'x-api-key' has invalid value: '…'`), so
// the literal key IS the substring. The retired Brave tool carried that proof through Bun's REAL fetch;
// its Exa twin had only a SIMULATED throw, which proves the redaction runs but not that it matches what
// Bun actually says. This drives the real thing.
//
// STILL HERMETIC, and provably so: header validation happens locally, when the Request is constructed,
// so `fetch` throws before any DNS lookup or socket. The assertion that PROVES it took that path rather
// than a network one is `stderr` containing Bun's own "invalid value" wording — a DNS failure would say
// something else entirely, and the test would fail. No `fetchFn` override.
describe("Search: the key never leaks, through Bun's REAL fetch (N5)", () => {
  const ZWSP = "​";
  const LEAKY_KEY = `exa_live_looking_key_never_print_me${ZWSP}`;   // trailing U+200B — `.trim()` keeps it

  function realFetchHarness(key: string) {
    const audit: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    // No `fetchFn`: the tool calls the global `fetch`, at its own `EXA_ANSWER_URL`. That url is never
    // REACHED — the illegal header is rejected while the Request is being built — which is what keeps
    // this hermetic without an endpoint seam the tool does not have.
    registerSearchTool(registry, { audit: (line) => audit.push(line), secret: async () => key });
    return { registry, audit };
  }

  test("a stray U+200B in the key never reaches the tool_result or the audit line", async () => {
    const h = realFetchHarness(LEAKY_KEY);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await h.registry.execute("Search", { query: "winter release notes" }, ctx());
      expect(out.isError).toBe(true);
      // The model sees the one static sentence, never the provider's or Bun's own text.
      expect(out.output).toBe("search failed: could not reach the search service");
      expect(out.output).not.toContain(LEAKY_KEY);
      expect(out.output).not.toContain("exa_live_looking_key");
      expect(JSON.stringify(h.audit)).not.toContain("exa_live_looking_key");
      expect(h.audit[0]).toMatchObject({ kind: "network", tool: "Search", outcome: "network_error" });
    } finally {
      errSpy.mockRestore();
    }
  });

  test("the LOG line is redacted too — and stays diagnostic, which is why a blanket scrub is not the fix", async () => {
    // `launchd.ts` sends the daemon's stderr to `<home>/logs/`, which is deliberately agent-READABLE
    // (only `run/` and `runtimes/` are denied), so a key in a log line is a key the model can read.
    const h = realFetchHarness(LEAKY_KEY);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.registry.execute("Search", { query: "q" }, ctx());
      const stderrText = errSpy.mock.calls.map((c) => c.map((x) => String(x)).join(" ")).join("\n");
      expect(stderrText).not.toContain(LEAKY_KEY);
      expect(stderrText).not.toContain("exa_live_looking_key");
      // The proof that `replaceAll(key, …)` matched what Bun really said: Bun's own words survive
      // around the hole where the key was.
      expect(stderrText).toContain("invalid value");
      expect(stderrText).toContain("<redacted>");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("a clean key's genuine failure keeps its real diagnostic — the redaction is a no-op, not a scrub", async () => {
    const h = harness({
      key: "clean-ascii-key",
      respond: () => { throw new Error("getaddrinfo ENOTFOUND api.exa.ai"); },
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.registry.execute("Search", { query: "q" }, ctx());
      const stderrText = errSpy.mock.calls.map((c) => c.map((x) => String(x)).join(" ")).join("\n");
      expect(stderrText).toContain("ENOTFOUND");
      expect(stderrText).not.toContain("<redacted>");
    } finally {
      errSpy.mockRestore();
    }
  });
});
