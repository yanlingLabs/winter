import { z } from "zod";
import type { ToolRegistry } from "./registry";

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
}

interface ExaSearchResponse {
  results?: Array<{ title?: string; url?: string; text?: string }>;
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
      "Search the web and get back results WITH an excerpt of each page, in a single fast call. Use it freely whenever a fact might be newer than you are, or when the user asks about something current. Cite the URL when you use what it returns.",
    // Deliberately NOT `deferred: true` (unlike code's web_search): CHAT_ALLOW_TOOLS contains no
    // ToolSearch, so a deferred Search could never have its schema loaded — it would appear in
    // chat's instructions and be permanently uncallable. That is the pre-existing dispatch-
    // allowlist bug (DISPATCH_ALLOW_TOOLS advertises web_fetch/web_search while omitting
    // ToolSearch) — this file does not repeat it, and a named test pins the fix.
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
          throw new Error("Search needs an API key — store one with: norma login --exa-key <key> (from exa.ai)");
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
            signal,
          });
        } catch (e) {
          const name = e instanceof Error ? e.name : "";
          if (name === "AbortError" || name === "TimeoutError") {
            outcome = "timeout";
            throw new Error(`search timed out for ${query}`);
          }
          outcome = "network_error";
          throw new Error(`search failed: ${e instanceof Error ? e.message : String(e)}`);
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

        const results = (data.results ?? []).slice(0, count);
        outcome = "ok";
        if (results.length === 0) return `no results for ${query}`;
        const rendered = results
          .map((x, i) => {
            const excerpt = (x.text ?? "").slice(0, EXCERPT_CHARS).trim();
            return `${i + 1}. ${x.title ?? "-"}\n   ${x.url ?? "-"}\n   ${excerpt || "(no excerpt)"}`;
          })
          .join("\n\n");
        // Chat has no `read` tool — unlike code's web_fetch there is no save-to-file escape
        // hatch, so this string is ALL the model gets. Cap it hard: a correctness constraint, not
        // just a safety one.
        return rendered.length > TOTAL_OUTPUT_CHARS
          ? rendered.slice(0, TOTAL_OUTPUT_CHARS) + "\n\n[results truncated]"
          : rendered;
      } finally {
        // `query` only — the key must NEVER reach the audit line.
        deps.audit?.({ kind: "network", tool: "Search", query, outcome });
      }
    },
  });
}
