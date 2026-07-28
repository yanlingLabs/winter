import { z } from "zod";
import type { ToolRegistry } from "./registry";
import { checkDangerousDomain } from "./page-core";

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const EXCERPT_CHARS = 1200; // per result — also what we ask Exa to cap `text` to server-side
const TOTAL_OUTPUT_CHARS = 30_000; // whole-response cap; see run()'s doc comment for why
const EXA_SEARCH_URL = "https://api.exa.ai/search";

/** Keychain secret name for the Exa API key — ONE exported const shared by the daemon wiring
 *  (daemon.ts) and `norma login --exa-key` (cli/src/main.ts), so the two can never drift on the
 *  literal. Same precedent as WEB_SEARCH_API_KEY_SECRET (web.ts:18). */
export const EXA_API_KEY_SECRET = "exa-api-key";

export interface SearchToolDeps {
  /** Emits one line per call, every outcome — same shape/precedent as web.ts's WebToolDeps.audit.
   *  NEVER includes the API key: only `{kind, tool, query, outcome}`. */
  audit?: (line: Record<string, unknown>) => void;
  /** Test-only injection point (defaults to global fetch) — no live network in the test suite. */
  fetchFn?: typeof fetch;
  /** Search's ONLY route to its Exa API key — daemon.ts wires this as `(name) => secrets.get(name)`
   *  over the same KeychainSecretStore instance the daemon already builds. Undefined (test
   *  default) is treated identically to "no key stored". */
  secret?: (name: string) => Promise<string | null>;
  /** Critical 1 fold-in (whole-branch review, USER-REVISED design 2026-07-28): "dangerous URLs
   *  never even get SHOWN to the model" — blocking the read (ReadPage/FetchPage) while still
   *  advertising the link in a Search result would be a half-measure: the model would just try the
   *  link, fail, and possibly retry. SAME shape/getter as ReadPage's/the research runner's own
   *  `dangerousDomainsAdded` (and daemon.ts wires all three to the literal SAME function). Absent →
   *  no user additions; the SHIPPED list alone still applies. */
  dangerousDomainsAdded?: (cwd?: string) => string[] | undefined;
}

interface ExaSearchResponse {
  results?: Array<{ title?: string; url?: string; text?: string }>;
}

/** Shape-checks a parsed Exa response body just enough to safely index into it — NOT full schema
 *  validation, just a guarantee that `results` is either absent or an array of non-null objects,
 *  so the `.slice`/`.map`/`x.title` chain below can never throw a raw TypeError that (a) leaks
 *  internal detail (e.g. "results.map is not a function") into the model-visible tool_result, and
 *  (b) gets mislabeled outcome="ok" in the audit line, since that exception fires AFTER `outcome`
 *  is set to "ok" (branch review FIX 5: `results:"str"` -> ok, `results:{}` -> network_error,
 *  `results:[null]` -> ok — all three should be `parse_error`, the outcome that already exists for
 *  exactly this). */
function isValidExaResults(value: unknown): value is Array<{ title?: string; url?: string; text?: string }> | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => item !== null && typeof item === "object");
}

/**
 * Chat's Exa-backed web search (B1-T5). Verified live against Exa's docs before writing this file
 * (task-5-report.md carries the full transcript): `POST https://api.exa.ai/search`, auth via the
 * `x-api-key` header, and a `contents: { text: { maxCharacters } }` field on the SAME request body
 * that returns each result's `text` inline in the SAME response — no second round-trip. That
 * single-call property is the entire reason chat uses Exa instead of code mode's two-step
 * web_search + web_fetch (Brave has no equivalent single-call contents option).
 */
export function registerSearchTool(r: ToolRegistry, deps: SearchToolDeps = {}): void {
  r.register({
    name: "Search",
    description:
      "Search the web and get back results WITH an excerpt of each page, in a single fast call. Use it freely whenever a fact might be newer than you are, or when the user asks about something current. Cite the URL when you use what it returns. Requires a stored Exa API key (norma login --exa-key).",
    // Deliberately NOT `deferred: true` (unlike code's web_search): chat's derived toolset
    // (registry.namesForMode("chat")) has no ToolSearch member unless something chat-eligible is
    // itself deferred (nothing is), so a deferred Search here could never have its schema loaded —
    // it would appear in chat's instructions and be permanently uncallable. That mirrors bug #7,
    // the pre-existing dispatch-allowlist bug fixed by R-T2's `namesForMode` auto-ToolSearch
    // addition (registry.ts): dispatch used to advertise web_fetch/web_search (both `deferred:
    // true`) with no ToolSearch entry point of its own, making them permanently unloadable — this
    // file does not repeat that, and a named test pins the fix.
    // R-T3 (Task 3) went further and removed web_fetch/web_search from dispatch's `modes` entirely
    // (web.ts) — dispatch now routes web lookups through THIS tool instead, not deferred, so it
    // needs no ToolSearch round-trip and returns page excerpts in one call. dispatch-prompt.ts's
    // DISPATCH_SYSTEM_PROMPT routing doctrine names "Search" explicitly, not web_search/web_fetch.
    modes: ["chat", "dispatch"],
    args: z.object({
      query: z.string().min(1),
      max_results: z.number().int().positive().optional(),
    }),
    async run({ query, max_results }, ctx) {
      let outcome = "network_error";
      try {
        const key = (await deps.secret?.(EXA_API_KEY_SECRET)) ?? null;
        if (!key) {
          outcome = "no_key";
          // No `<key>` placeholder (branch review FIX 6): the CLI's --exa-key branch ignores a
          // positional argv value and always PROMPTS via readSecret — a message implying
          // otherwise would walk a user into pasting their key into shell history for nothing.
          throw new Error("Search needs an API key — store one with: norma login --exa-key (from exa.ai)");
        }
        const count = Math.min(Math.max(max_results ?? DEFAULT_RESULTS, 1), MAX_RESULTS);
        const fetchFn = deps.fetchFn ?? fetch;
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([ctx.signal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s)));

        let res: Response;
        try {
          res = await fetchFn(EXA_SEARCH_URL, {
            method: "POST",
            headers: { "x-api-key": key, "content-type": "application/json" },
            // The single-call property, verified live: `contents` rides the SAME request body as
            // `query`, so the response's `results[].text` is populated with no second call. THIS
            // is why chat uses Exa and not code's Brave two-step.
            body: JSON.stringify({
              query,
              numResults: count,
              contents: { text: { maxCharacters: EXCERPT_CHARS } },
            }),
            // FIX 4: Exa's search endpoint should never redirect. Without this, fetch's default
            // `follow` behavior would carry the `x-api-key` header to whatever a 3xx response's
            // `Location` points at from hop 2 onward — a destination no longer under Exa's
            // control. `manual` turns any 3xx into a plain non-200 response, handled by the
            // `res.status !== 200` branch below as `http_error` (web_fetch's followRedirects
            // already uses this same pattern with its own per-hop SSRF guard).
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
          // `~/.norma/logs/core.err.log`, and that directory is DELIBERATELY agent-readable
          // (daemon.ts denies only `dirs.runDir` to the read/grep tools) — so the raw key would
          // still land somewhere Norma's own tools can open it, just one hop removed. Redact the
          // literal key substring out of the message before it ever reaches this log line.
          //
          // `replaceAll` is sufficient: verified live (bun 1.3.14) that Bun's fetch embeds the
          // rejected header value in `e.message` byte-for-byte, with no escaping/normalization —
          // plain ASCII, U+200B, CR, LF, CRLF, NUL and BOM all round-tripped as an EXACT substring
          // in testing, at both short and realistic key lengths (no truncation observed either).
          // No transformation that would defeat a literal match was found for the cases that
          // actually reach this catch block (a couple of other control chars, e.g. tab/DEL, don't
          // trigger Bun's header-value rejection at all, so they never reach this code path).
          const rawMessage = e instanceof Error ? e.message : String(e);
          const safeMessage = rawMessage.replaceAll(key, "<redacted>");
          console.error(`Search: network error (${name || "Error"}) — ${safeMessage}`);
          throw new Error("search failed: could not reach the search service");
        }

        if (res.status !== 200) {
          outcome = "http_error";
          throw new Error(`search failed: HTTP ${res.status}`);
        }

        let data: ExaSearchResponse;
        try {
          data = (await res.json()) as ExaSearchResponse;
        } catch (e) {
          outcome = "parse_error";
          throw new Error(`search failed: could not parse response (${e instanceof Error ? e.message : String(e)})`);
        }

        if (!isValidExaResults(data.results)) {
          outcome = "parse_error";
          throw new Error("search failed: malformed response from search service");
        }

        const rawResults = (data.results ?? []).slice(0, count);
        // Critical 1 fold-in (whole-branch review): strip any result whose url matches the
        // effective dangerous-domain list BEFORE it ever reaches the model — advertising the link
        // while blocking the read (ReadPage/FetchPage) would just have the model try it, fail, and
        // possibly retry. Never a SILENT drop: the withheld count is always stated, so the model
        // (and anyone reading the transcript) knows the result set was intentionally filtered, not
        // just shorter than requested.
        const added = deps.dangerousDomainsAdded?.(ctx.cwd) ?? [];
        let withheld = 0;
        const results = rawResults.filter((x) => {
          if (!x.url || !checkDangerousDomain(x.url, added)) return true;
          withheld++;
          return false;
        });
        const withheldNote = withheld > 0
          ? `\n\n[${withheld} result${withheld === 1 ? "" : "s"} withheld — matched the dangerous-domain list]`
          : "";
        outcome = "ok";
        if (results.length === 0) return `no results for ${query}${withheldNote}`;
        const rendered = results
          .map((x, i) => {
            const excerpt = (x.text ?? "").slice(0, EXCERPT_CHARS).trim();
            return `${i + 1}. ${x.title ?? "-"}\n   ${x.url ?? "-"}\n   ${excerpt || "(no excerpt)"}`;
          })
          .join("\n\n");
        // Chat has no `read` tool — unlike code's web_fetch there is no save-to-file escape
        // hatch, so this string is ALL the model gets. Cap it hard: a correctness constraint, not
        // just a safety one.
        const capped = rendered.length > TOTAL_OUTPUT_CHARS
          ? rendered.slice(0, TOTAL_OUTPUT_CHARS) + "\n\n[results truncated]"
          : rendered;
        return capped + withheldNote;
      } finally {
        // `query` only — the key must NEVER reach the audit line.
        deps.audit?.({ kind: "network", tool: "Search", query, outcome });
      }
    },
  });
}
