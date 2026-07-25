import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegistry } from "./registry";

const MAX_FETCH_BYTES = 5 * 1024 * 1024; // hard cap on bytes READ off the wire (streamed — see readCapped)
const PREVIEW_BYTES = 8192;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 3;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;

/** Keychain secret name for the Brave Search API key (4g Task 6) — shared between the daemon's
 *  `registerWebTools` wiring (packages/core/src/daemon.ts) and the CLI's `norma login
 *  --web-search-key` (packages/cli/src/main.ts), same precedent as providers/manager.ts's
 *  OPENAI_API_KEY_SECRET: ONE exported const so the two call sites can never drift apart on the
 *  literal string. */
export const WEB_SEARCH_API_KEY_SECRET = "web-search-api-key";

// module-level, per-process — names saved files webfetch-<n>-<host>.md (USER DESIGN, task-5-brief.md)
let fetchCounter = 0;

/** First-two-octets private/loopback/link-local IPv4 check — shared by literal IPv4 hosts
 *  (`10.0.0.1`) AND IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1` / its canonical hex form
 *  `::ffff:a00:1`), which resolve to the exact same 32-bit address and must not evade the guard
 *  just because they're spelled as IPv6. */
function ipv4Refusal(a: number, b: number): string | null {
  if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return `refusing to fetch a private address`;
  }
  return null;
}

/** Norma's ONLY sanctioned network egress (spec 4g §4.3) — bash stays sandboxed (network denied).
 *  v1 SSRF posture: literal private/loopback/link-local hosts rejected; DNS-rebinding is out of
 *  scope (documented). Response bytes are DATA, never instructions. */
export function ssrfGuard(raw: string): string | null {
  let u: URL; try { u = new URL(raw); } catch { return `invalid url: ${raw}`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `only http(s) urls are allowed`;

  let h = u.hostname.toLowerCase();
  // Trailing-dot FQDN normalization: "localhost." / "10.0.0.1." are the SAME address as their
  // dot-less forms (a trailing dot is just the DNS root label) but defeat `h === "localhost"` /
  // the IPv4 regex if left as-is. Strip ONE trailing dot before every check below.
  if (h.endsWith(".")) h = h.slice(0, -1);
  // IPv6 literals arrive bracketed from URL.hostname ("[fe80::1]") — unwrap BEFORE any check,
  // else every prefix/equality check below is structurally dead (nothing starts with "fc" once
  // bracketed). Remember it WAS a literal so the ULA/link-local prefix check below only applies to
  // real IPv6 literals, never to a domain that merely starts with "fc"/"fd"/"fe80" (fcc.gov etc.).
  const wasIpv6Literal = h.startsWith("[") && h.endsWith("]");
  if (wasIpv6Literal) h = h.slice(1, -1);

  if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0") return `refusing to fetch a local address`;

  const ip4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip4) { const refusal = ipv4Refusal(Number(ip4[1]), Number(ip4[2])); if (refusal) return refusal; }

  // IPv6 loopback / unspecified.
  if (h === "::1" || h === "::" || (h.includes(":") && h.split(":").every((g) => g === "" || /^0+$/.test(g)))) {
    return `refusing to fetch a local address`;
  }

  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`, or its canonical hex form `::ffff:XXXX:YYYY` — the form
  // URL.hostname actually normalizes to) resolves to a real IPv4 address and must be checked
  // against the SAME private-range table as literal IPv4 hosts (the textbook v4-blocklist bypass).
  const mappedDotted = h.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (mappedDotted) { const refusal = ipv4Refusal(Number(mappedDotted[1]), Number(mappedDotted[2])); if (refusal) return refusal; }
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const g1 = parseInt(mappedHex[1]!, 16);
    const refusal = ipv4Refusal((g1 >> 8) & 0xff, g1 & 0xff);
    if (refusal) return refusal;
  }

  // IPv6 ULA (fc00::/7) + link-local (fe80::/10) — ONLY for actual IPv6 literals, else a bare
  // string-prefix match wrongly refuses public domains like fcc.gov / fdic.gov / fc-barcelona.com.
  // fc00::/7 (top 7 bits fixed) is exactly captured by the "fc"/"fd" hex-nibble prefixes. But
  // fe80::/10 (top 10 bits fixed) is NOT a whole-nibble prefix — the first hextet ranges over
  // 0xfe80–0xfebf (fe80::, fe90::, fea0::, feb0::, … up to febf::), so a bare `startsWith("fe80")`
  // string check misses fe90::/fea0::/feb0:: entirely. Range-check the first hextet numerically
  // instead — a public domain merely starting with "fe" (fear.com) never reaches this branch at
  // all (wasIpv6Literal gates the whole thing), so this can't over-block those.
  if (wasIpv6Literal) {
    if (h.startsWith("fc") || h.startsWith("fd")) return `refusing to fetch a private address`;
    const firstHextet = parseInt(h.split(":")[0] ?? "", 16);
    if (!Number.isNaN(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) {
      return `refusing to fetch a private address`;
    }
  }
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<head[\s\S]*?<\/head>/gi, "")
    // structure worth keeping (user design): headings → #, links → text (url), list items → "- "
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${"#".repeat(Number(n))} ${t}\n`)
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `${t} (${href})`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

/** Title extraction happens on the RAW html, before htmlToText runs on the whole page (which
 *  destroys the tags this looks for). Reuses htmlToText only on the small extracted h1/title
 *  snippet — that's just tag-stripping + entity-decoding, not the whole-page conversion. */
function extractTitle(html: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const src = h1?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!src) return "-";
  const text = htmlToText(src).replace(/\n+/g, " ").trim();
  return text || "-";
}

/** Reads a Response body up to `capBytes`, cancelling the underlying stream once the cap is hit —
 *  truncation happens DURING collection (never read-then-slice), so a multi-GB response can't OOM
 *  the daemon before the cap applies. Mirrors bash.ts's MAX_CAPTURE streaming-truncation pattern —
 *  Norma's only network egress gets the same discipline bash's output capture already has. */
async function readCapped(res: Response, capBytes: number): Promise<{ text: string; bytesRead: number }> {
  if (!res.body) {
    const text = await res.text();
    const buf = Buffer.from(text, "utf8");
    return buf.byteLength > capBytes
      ? { text: buf.subarray(0, capBytes).toString("utf8"), bytesRead: capBytes }
      : { text, bytesRead: buf.byteLength };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      chunks.push(value);
      if (total >= capBytes) {
        try { await reader.cancel(); } catch { /* stream already closing */ }
        break;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
  }
  const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const bytesRead = Math.min(combined.byteLength, capBytes);
  return { text: combined.subarray(0, capBytes).toString("utf8"), bytesRead };
}

export interface FollowRedirectsOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  maxHops?: number;
}
export interface FetchSuccess { ok: true; url: string; status: number; contentType: string; body: string; bytesRead: number }
// `url` is the current/last-attempted hop — needed so callers can audit the FINAL resolved
// address on a failure that happens mid-redirect-chain, not just the originally-requested one.
export interface FetchFailure { ok: false; error: string; kind: "ssrf" | "redirects" | "http" | "timeout" | "network"; url: string }
export type FollowResult = FetchSuccess | FetchFailure;

/** SSRF-guarded manual-redirect loop: guards EVERY hop (including the first) — a compliant first
 *  URL must not be able to 302 into a private address. `fetchFn` is injectable so tests drive this
 *  with a fake (no live network in unit tests); it defaults to the global fetch. */
export async function followRedirects(startUrl: string, opts: FollowRedirectsOptions = {}): Promise<FollowResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  let current = startUrl;
  for (let redirects = 0; ; redirects++) {
    const guardErr = ssrfGuard(current);
    if (guardErr) return { ok: false, error: guardErr, kind: "ssrf", url: current };

    let res: Response;
    try {
      res = await fetchFn(current, { redirect: "manual", signal: opts.signal });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError" || name === "TimeoutError") {
        return { ok: false, error: `request timed out fetching ${current}`, kind: "timeout", url: current };
      }
      return { ok: false, error: `fetch failed: ${e instanceof Error ? e.message : String(e)}`, kind: "network", url: current };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: `redirect (${res.status}) with no Location header`, kind: "http", url: current };
      if (redirects >= maxHops) return { ok: false, error: `too many redirects (>${maxHops} hops)`, kind: "redirects", url: current };
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `fetch failed: ${res.status}`, kind: "http", url: current };

    const contentType = res.headers.get("content-type") ?? "";
    const { text, bytesRead } = await readCapped(res, MAX_FETCH_BYTES);
    return { ok: true, url: current, status: res.status, contentType, body: text, bytesRead };
  }
}

export interface WebToolDeps {
  /** Emits one line per call, EVERY outcome (success, ssrf-refusal, http error, timeout, ...) —
   *  matching how hardware.ts audits (peripheral/hardware.ts's `deps.audit.append(...)`), but
   *  threaded as a plain callback (not the AuditLog class) so tests don't need a real file. */
  audit?: (line: Record<string, unknown>) => void;
  /** Test-only injection point (defaults to global fetch, same as followRedirects' own default) —
   *  lets the file-write/result-shape test drive the FULL run() through registerWebTools without
   *  live network, the same way followRedirects' own tests drive it directly. */
  fetchFn?: typeof fetch;
  /** web_search's ONLY route to its Brave API key — daemon.ts wires this as `(name) =>
   *  secrets.get(name)` over the SAME KeychainSecretStore instance the daemon already builds
   *  (auth/secret-store.ts). Plain function (not the SecretStore interface) so this file doesn't
   *  need a cross-directory import into auth/ just for a type. Undefined (test default) is treated
   *  identically to "no key stored" — web_search's no-key error path covers both. */
  secret?: (name: string) => Promise<string | null>;
}

export function registerWebTools(r: ToolRegistry, deps: WebToolDeps = {}): void {
  r.register({
    name: "web_fetch",
    description:
      "Fetch a URL (http/https) and return a preview of its readable text content. Norma's only network-capable tool — bash has no network. The full converted page is saved to a file (its path is in the result) — use read/grep/spawn_agent on that file for anything beyond the preview. Fetch is read-only GET.",
    // url only — no `prompt` (CC's web_fetch takes an optional page-digest prompt). Deliberate spec
    // deviation: the save-to-tmp result shape below already gives the model read/grep/spawn_agent
    // access to the FULL saved page, so a fetch-time digest prompt is redundant. Also no `max_bytes`:
    // the 5MB read cap and 8192-byte preview are fixed constants (not caller-tunable), keeping the
    // SSRF/DoS posture uniform regardless of what a caller asks for.
    args: z.object({ url: z.string().min(1) }),
    deferred: true, // T1 machinery, per-def flag — same pattern as task_get
    async run({ url }, ctx) {
      let outcome = "network_error";
      // Last hop's resolved URL (from followRedirects — set on BOTH success and failure, since a
      // failure can happen mid-redirect-chain too). Audited alongside the originally-requested
      // `url` when it differs, so a redirect chain's actual source is never silently dropped.
      let finalUrl: string | undefined;
      try {
        if (!ctx.tmpDir) {
          outcome = "no_tmp_dir";
          throw new Error("web_fetch requires a session tmp directory (ctx.tmpDir is unset)");
        }
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([ctx.signal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s)));

        const res = await followRedirects(url, { fetchFn: deps.fetchFn, signal });
        finalUrl = res.url;
        if (!res.ok) {
          outcome = res.kind === "ssrf" ? "ssrf_refused"
            : res.kind === "timeout" ? "timeout"
            : res.kind === "redirects" ? "too_many_redirects"
            : res.kind === "http" ? "http_error"
            : "network_error";
          throw new Error(res.error);
        }
        // Fetch succeeded — anything that throws past this point (e.g. the file write below) is a
        // local/write failure, not a network one, so it must not be mislabeled "network_error".
        outcome = "fetched";

        const isHtml = res.contentType.toLowerCase().includes("text/html");
        const finalText = isHtml ? htmlToText(res.body) : res.body;
        const title = isHtml ? extractTitle(res.body) : "-";

        const host = new URL(res.url).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
        const filename = `webfetch-${++fetchCounter}-${host}.md`;
        let savedPath: string;
        try {
          mkdirSync(ctx.tmpDir, { recursive: true });
          savedPath = join(ctx.tmpDir, filename);
          writeFileSync(savedPath, finalText);
        } catch (e) {
          outcome = "write_error";
          throw e;
        }

        const savedBytes = Buffer.byteLength(finalText, "utf8");
        const preview = Buffer.from(finalText, "utf8").subarray(0, PREVIEW_BYTES).toString("utf8");

        outcome = "ok";
        return [
          `Fetched ${res.url} (HTTP ${res.status}, ${res.contentType || "unknown content-type"}, ${res.bytesRead} bytes → ${savedBytes} bytes text)`,
          `Title: ${title}`,
          `Saved to: ${savedPath}`,
          `--- preview (first 8192 bytes) ---`,
          preview,
          `--- end preview ---`,
          `Full page saved. Use read with offset/limit to page through it, grep to search it, or spawn_agent to digest it.`,
        ].join("\n");
      } finally {
        deps.audit?.({
          kind: "network", tool: "web_fetch", url,
          ...(finalUrl !== undefined && finalUrl !== url ? { finalUrl } : {}),
          outcome,
        });
      }
    },
  });

  r.register({
    name: "web_search",
    description:
      "Search the web (Brave Search) and return a numbered list of results (title, url, description). Norma's only search tool — pair with web_fetch to read a result's full page. Requires a stored Brave Search API key (norma login --web-search-key).",
    args: z.object({
      query: z.string().min(1),
      // Default 5, hard-clamped to 10 below — caller-tunable but never unbounded (same DoS
      // posture as web_fetch's fixed byte caps, just expressed as a result-count cap instead).
      max_results: z.number().int().positive().optional(),
    }),
    deferred: true, // same class as web_fetch — rides ToolSearch deferral, not visible/callable until loaded
    async run({ query, max_results }, ctx) {
      let outcome = "network_error";
      try {
        const key = (await deps.secret?.(WEB_SEARCH_API_KEY_SECRET)) ?? null;
        if (!key) {
          outcome = "no_key";
          // No `<key>` placeholder (branch review FIX 6): the CLI's --web-search-key branch
          // ignores a positional argv value and always PROMPTS via readSecret.
          throw new Error(
            "web_search needs an API key — store one with: norma login --web-search-key (Brave Search API)",
          );
        }

        const count = Math.min(Math.max(max_results ?? DEFAULT_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
        const fetchFn = deps.fetchFn ?? fetch;
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([ctx.signal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s)));
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

        let res: Response;
        try {
          res = await fetchFn(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal });
        } catch (e) {
          const name = e instanceof Error ? e.name : "";
          if (name === "AbortError" || name === "TimeoutError") {
            outcome = "timeout";
            throw new Error(`request timed out searching for ${query}`);
          }
          outcome = "network_error";
          // FIX 1's identical twin (branch review): Bun's real fetch embeds an invalid header's
          // VALUE verbatim in its own error text (confirmed live against the Brave
          // `X-Subscription-Token` header, same as Search's `x-api-key`) — and unlike chat's
          // Search, this tool's output is remote-reachable (a code session is drivable from a
          // phone), so the leak matters even more here. Detail goes to stderr only.
          console.error(`web_search: network error — ${e instanceof Error ? e.message : String(e)}`);
          throw new Error("web_search failed: could not reach the search service");
        }

        if (res.status !== 200) {
          outcome = "http_error";
          throw new Error(`web_search failed: HTTP ${res.status}`);
        }

        let data: { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
        try {
          data = (await res.json()) as typeof data;
        } catch (e) {
          outcome = "parse_error";
          throw new Error(`web_search failed: could not parse response (${e instanceof Error ? e.message : String(e)})`);
        }

        const results = (data.web?.results ?? []).slice(0, count);
        outcome = "ok";
        if (results.length === 0) return `no results for ${query}`;
        return results
          .map((r, i) => `${i + 1}. ${r.title ?? "-"}\n   ${r.url ?? "-"}\n   ${r.description ?? "-"}`)
          .join("\n");
      } finally {
        deps.audit?.({ kind: "network", tool: "web_search", query, outcome });
      }
    },
  });
}
