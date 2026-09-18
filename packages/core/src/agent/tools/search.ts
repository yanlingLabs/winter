import { z } from "zod";
import type { ToolDefinition, ToolRegistry } from "./registry";
import { checkDangerousDomain } from "./page-core";

/** `/answer` SYNTHESIZES — it runs a search and then writes a grounded answer over the results, so
 *  it is materially slower than the old `/search` round trip (which only returned rows). 15 s was
 *  tuned for that older, cheaper call and would time out answers that were going to arrive. */
const REQUEST_TIMEOUT_MS = 45_000;
const ANSWER_CHARS = 24_000; // the synthesized answer itself
const MAX_CITATIONS = 20; // rendered as a sources list; the provider decides how many it used
const TOTAL_OUTPUT_CHARS = 30_000; // whole-response cap; see run()'s doc comment for why
const EXA_ANSWER_URL = "https://api.exa.ai/answer";

/** Keychain secret name for the Exa API key — ONE exported const shared by the daemon wiring
 *  (daemon.ts), `winter login --exa-key` (cli/src/main.ts), the `exa` credential row
 *  (`runtime-sdk/credentials.ts`) and the `Options.web.search.authRef` locator the Winter child
 *  resolves for its own `WebSearch` (`runtime-sdk/mode-options.ts`), so none of them can ever drift
 *  on the literal. */
export const EXA_API_KEY_SECRET = "exa-api-key";

export interface SearchToolDeps {
  /** Emits one line per call, every outcome — same shape/precedent as the audit lines the other
   *  network-class tools emit. NEVER includes the API key: only `{kind, tool, query, outcome}`. */
  audit?: (line: Record<string, unknown>) => void;
  /** Test-only injection point (defaults to global fetch) — no live network in the test suite. */
  fetchFn?: typeof fetch;
  /** Search's ONLY route to its Exa API key — daemon.ts wires this as `(name) => secrets.get(name)`
   *  over the same KeychainSecretStore instance the daemon already builds. Undefined (test
   *  default) is treated identically to "no key stored". */
  secret?: (name: string) => Promise<string | null>;
  /** Critical 1 fold-in (whole-branch review, USER-REVISED design 2026-07-28): "dangerous URLs
   *  never even get SHOWN to the model" — citing a floor-listed page while blocking every read of
   *  it would be a half-measure: the model would just try the link, fail, and possibly retry. SAME
   *  shape/getter as the browser tool's own `dangerousDomainsAdded` (and daemon.ts wires them to
   *  the literal SAME function). Absent → no user additions; the SHIPPED list alone still applies. */
  dangerousDomainsAdded?: (cwd?: string) => string[] | undefined;
}

/** What `/answer` returns (2026-09-18, verified against Exa's own reference for the endpoint):
 *  `answer` is the synthesized text — a string unless the request asked for structured output,
 *  which this tool never does — and `citations` are the pages it was grounded in, each carrying at
 *  least `title` and `url`. `requestId`/`costDollars` also ride along and are deliberately ignored:
 *  neither is anything the model should be shown, and `costDollars` is not this tool's ledger. */
interface ExaAnswerResponse {
  answer?: unknown;
  citations?: Array<{ title?: string; url?: string }>;
}

/** Shape-checks a parsed `/answer` body just enough to safely index into it — NOT full schema
 *  validation, just a guarantee that `citations` is either absent or an array of non-null objects,
 *  so the `.slice`/`.filter`/`x.title` chain below can never throw a raw TypeError that (a) leaks
 *  internal detail ("citations.filter is not a function") into the model-visible tool_result, and
 *  (b) gets mislabeled `outcome:"ok"`, since such an exception would fire AFTER `outcome` is set.
 *  Carried over verbatim in spirit from the `/search` era's `isValidExaResults` (branch review
 *  FIX 5), which existed for exactly these three cases: `citations:"str"`, `citations:{}`,
 *  `citations:[null]` — all three are `parse_error`, the outcome that already exists for them. */
function isValidExaCitations(value: unknown): value is Array<{ title?: string; url?: string }> | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => item !== null && typeof item === "object");
}

/**
 * Chat's and dispatch's web search — **Exa's ANSWER mode** (user ruling, 2026-09-18).
 *
 * `POST https://api.exa.ai/answer`, auth via the `x-api-key` header (never a query parameter), and
 * the response is a ready SYNTHESIZED answer plus the citations it was grounded in. That is the
 * whole reason this tool still exists beside the runtime's own `WebSearch`: one call gives a small
 * conversational model a written answer with sources, where `WebSearch` gives it links to chase and
 * chat has no page-reading tool to chase them with.
 *
 * `/answer` REQUIRES a key. So this tool's presence is itself gated on one being stored, at two
 * places that must agree: `capabilities/research.ts` (the server advertises no `Search` without a
 * key) and `runtime-sdk/mode-options.ts`'s `disallowedToolsFor` (which names it in
 * `disallowedTools` in that same case, and withholds the runtime's `WebSearch` in the complement).
 * The `no_key` branch below is therefore unreachable through a real session and is kept anyway: a
 * typed, actionable failure is the right answer for a direct caller and for the window between a
 * key being removed and a live child's next incarnation.
 */
export function registerSearchTool(r: ToolRegistry, deps: SearchToolDeps = {}): void {
  for (const def of searchToolDefs(deps)) r.register(def);
}

/** P8b Task 7 — THE definition(s), extracted from `registerSearchTool`'s body so the daemon's shared
 *  `ToolRegistry` and the capability server drive the SAME `ToolDefinition` object rather than two
 *  copies of one. */
export function searchToolDefs(deps: SearchToolDeps = {}): ToolDefinition[] {
  return [{
    name: "Search",
    description:
      "Search the web and get back a written answer with its sources, in a single call. Ask a real question, not keywords — a search engine answers it and the answer comes back already synthesized, followed by the pages it came from. Use it freely whenever a fact might be newer than you are, or when the user asks about something current, and cite the URLs you used.",
    // Deliberately NOT `deferred: true`: chat's derived toolset has no ToolSearch member unless
    // something chat-eligible is itself deferred (nothing is), so a deferred Search here could
    // never have its schema loaded — it would appear in chat's instructions and be permanently
    // uncallable. That mirrors bug #7, the pre-existing dispatch-allowlist bug fixed by R-T2's
    // `namesForMode` auto-ToolSearch addition (registry.ts).
    modes: ["chat", "dispatch"],
    // ONE field, and that is the schema (claude-simple). The `/search` era's `max_results` is gone
    // with the endpoint: `/answer` returns an answer, not a page of rows, and how many sources it
    // consulted is the provider's judgement, not a caller's dial. Exa's other request fields
    // (`model`, `systemPrompt`, `userLocation`, `outputSchema`, `stream`, `text`) are deliberately
    // not exposed either — each is a knob whose wrong setting the model could not diagnose, and
    // `text: true` in particular would return every cited page's FULL body, which this tool does
    // not render and would only pay for.
    args: z.object({
      query: z.string().min(1),
    }),
    async run({ query }, ctx) {
      let outcome = "network_error";
      try {
        const key = (await deps.secret?.(EXA_API_KEY_SECRET)) ?? null;
        if (!key) {
          outcome = "no_key";
          // No `<key>` placeholder (branch review FIX 6): the CLI's --exa-key branch ignores a
          // positional argv value and always PROMPTS via readSecret — a message implying
          // otherwise would walk a user into pasting their key into shell history for nothing.
          throw new Error("Search needs an API key — store one with: winter login --exa-key (from exa.ai)");
        }
        const fetchFn = deps.fetchFn ?? fetch;
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([ctx.signal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s)));

        let res: Response;
        try {
          res = await fetchFn(EXA_ANSWER_URL, {
            method: "POST",
            headers: { "x-api-key": key, "content-type": "application/json" },
            body: JSON.stringify({ query }),
            // FIX 4: Exa's endpoints should never redirect. Without this, fetch's default `follow`
            // behavior would carry the `x-api-key` header to whatever a 3xx response's `Location`
            // points at from hop 2 onward — a destination no longer under Exa's control. `manual`
            // turns any 3xx into a plain non-200 response, handled by the status branch below.
            redirect: "manual",
            signal,
          });
        } catch (e) {
          const name = e instanceof Error ? e.name : "";
          if (name === "AbortError" || name === "TimeoutError") {
            outcome = "timeout";
            throw new Error(`search timed out for ${query}`);
          }
          outcome = "network_error";
          // FIX 1 (security, Important): NEVER interpolate the caught exception's message into the
          // tool_result. Bun's real fetch embeds an invalid header's VALUE verbatim in its own
          // error text (confirmed live: a stray U+200B in a copy-pasted key produces `Header
          // 'x-api-key' has invalid value: '...'`) — that string must never become the
          // model-visible/session-JSONL tool_result. The model/log only ever see a static message.
          //
          // Whole-branch re-review FIX (was: redirect the raw detail to console.error and call it
          // done): stderr is NOT operator-only here. `launchd.ts` redirects the daemon's stderr to
          // `~/.winter/logs/core.err.log`, and that directory is DELIBERATELY agent-readable
          // (daemon.ts denies only `dirs.runDir` to the read/grep tools) — so the raw key would
          // still land somewhere Winter's own tools can open it, just one hop removed. Redact the
          // literal key substring out of the message before it ever reaches this log line.
          const rawMessage = e instanceof Error ? e.message : String(e);
          const safeMessage = rawMessage.replaceAll(key, "<redacted>");
          console.error(`Search: network error (${name || "Error"}) — ${safeMessage}`);
          throw new Error("search failed: could not reach the search service");
        }

        if (res.status !== 200) {
          // ACTIONABLE, and never the provider's own body: an error body can echo request headers
          // (and therefore the key) and is attacker-influenced text besides. Only the status code
          // crosses into the tool_result, mapped to the one sentence that says what to DO.
          outcome = statusOutcome(res.status);
          throw new Error(statusMessage(res.status));
        }

        let data: ExaAnswerResponse;
        try {
          data = (await res.json()) as ExaAnswerResponse;
        } catch (e) {
          outcome = "parse_error";
          throw new Error(`search failed: could not parse response (${e instanceof Error ? e.message : String(e)})`);
        }

        if (!isValidExaCitations(data.citations)) {
          outcome = "parse_error";
          throw new Error("search failed: malformed response from search service");
        }
        // `answer` is a string unless `outputSchema` was sent, which this tool never sends. Anything
        // else is a shape this renderer cannot speak for, so it is a parse error rather than a
        // `String(object)` that would hand the model `[object Object]` labelled as an answer.
        if (data.answer !== undefined && typeof data.answer !== "string") {
          outcome = "parse_error";
          throw new Error("search failed: malformed response from search service");
        }
        const fullAnswer = (data.answer ?? "").trim();
        // NEVER a silent slice: an answer cut mid-sentence reads as a complete one, and a model that
        // cannot tell the difference will present half a conclusion as the whole of it.
        const answer = fullAnswer.length > ANSWER_CHARS
          ? fullAnswer.slice(0, ANSWER_CHARS) + "\n\n[answer truncated]"
          : fullAnswer;

        // The dangerous-domain floor, applied to the CITED urls — the same act the `/search` era
        // applied to result rows, for the same reason (a link the model is shown is a link the model
        // will try). Never a SILENT drop: the withheld count is always stated, so the model (and
        // anyone reading the transcript) knows the source list was filtered, not merely short.
        const added = deps.dangerousDomainsAdded?.(ctx.cwd) ?? [];
        const rawCitations = (data.citations ?? []).slice(0, MAX_CITATIONS);
        let withheld = 0;
        const citations = rawCitations.filter((c) => {
          if (!c.url || !checkDangerousDomain(c.url, added)) return true;
          withheld++;
          return false;
        });
        const withheldNote = withheld > 0
          ? `\n\n[${withheld} source${withheld === 1 ? "" : "s"} withheld — matched the dangerous-domain list]`
          : "";

        outcome = "ok";
        if (answer === "") return `no answer for ${query}${withheldNote}`;
        // An answer with NOTHING left to attribute is still the answer — the user asked a question
        // and a refusal here would be a worse outcome than an honest label. It is MARKED, because an
        // unsourced answer is exactly the one a model must not present as cited fact.
        const sources = citations.length === 0
          ? `\n\n[unsourced — ${withheld > 0
            ? "every source was withheld by the dangerous-domain list"
            : "the search service returned no sources"}; say so if you repeat this]`
          : "\n\nSources:\n" + citations
            .map((c, i) => `${i + 1}. ${c.title?.trim() || "-"}\n   ${c.url ?? "-"}`)
            .join("\n");
        const rendered = answer + sources;
        // Chat has no page-reading tool — unlike code's `WebFetch` there is no follow-the-link
        // escape hatch here, so this string is ALL the model gets. Cap it hard: a correctness
        // constraint, not just a safety one.
        const capped = rendered.length > TOTAL_OUTPUT_CHARS
          ? rendered.slice(0, TOTAL_OUTPUT_CHARS) + "\n\n[truncated]"
          : rendered;
        return capped + withheldNote;
      } finally {
        // `query` only — the key must NEVER reach the audit line.
        deps.audit?.({ kind: "network", tool: "Search", query, outcome });
      }
    },
  }];
}

/** The audit line's own vocabulary for a non-200 — finer than one `http_error` bucket precisely so
 *  an operator reading `audit.jsonl` can tell "the key is wrong" from "the account is out of
 *  credits" from "too fast", which are three different things for the user to fix. */
function statusOutcome(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402) return "out_of_credits";
  if (status === 429) return "rate_limited";
  return "http_error";
}

/** One sentence per documented failure, each naming the action that clears it. Deliberately the
 *  ONLY thing derived from a failed response — never its body (see the call site). */
function statusMessage(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "search failed: the stored Exa API key was rejected — replace it with `winter credentials set exa` (or `winter login --exa-key`)";
    case 402:
      return "search failed: this Exa account is out of credits or over its budget — top it up at exa.ai, or answer from what you already know and say the search was unavailable";
    case 429:
      return "search failed: the search service is rate-limiting this key — wait a little before searching again, and do not retry in a loop";
    case 400:
      return "search failed: the search service rejected the request as malformed — try a plainer question";
    default:
      return `search failed: the search service is unavailable (HTTP ${status})`;
  }
}
