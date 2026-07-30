import { extractTitle, followRedirects, htmlToText, scanAnchorOpensForLinks } from "./web";
import { SHIPPED_DANGEROUS_DOMAINS, dangerousDomainMatch } from "../dangerous-domains";

/**
 * page-core: the shared building block behind chat mode's `ReadPage` tool (read a web page as
 * clean numbered markdown with its links preserved, load line ranges, batch pages) and its
 * research sub-agent — fetch -> clean -> extract links -> deterministic line numbering ->
 * in-memory TTL cache. Deliberately NOT registered as a tool: this file is a pure module with no
 * filesystem, no shell, nothing chat-mode-specific — a later task wraps it as `ReadPage`.
 *
 * Reuses web.ts's `followRedirects` (SSRF-guards EVERY redirect hop, streams with a byte cap,
 * injectable `fetchFn`) and `htmlToText` (headings -> `#`, links -> `text (href)`, lists -> `- `)
 * — fetching, SSRF policy, and whole-page text cleaning are NOT reimplemented here. Link
 * EXTRACTION, though, must run on the RAW html BEFORE `htmlToText`, because `htmlToText` rewrites
 * every `<a>` tag into `text (href)` prose and so destroys the structure a link list needs.
 *
 * The cache is in-memory ONLY, and that is a SECURITY posture, not a performance choice: chat
 * mode's contract is that it leaves nothing behind, and `~/.norma` is agent-readable by design
 * (only the run dir is denied — see CLAUDE.md's tool-surface note) — a disk cache would put
 * fetched web content into a location the agent (and, on a shared machine, whoever else can read
 * that agent's files) can read outside of the conversation that fetched it. Memory-only means the
 * cache vanishes with the process, same as everything else about a chat session.
 */

/** Critical 1, whole-branch review (2026-07-28, USER-REVISED design): the shared dangerous-domain
 *  hard-block floor for ReadPage (chat/dispatch, read-page.ts) and the research sub-agent's
 *  FetchPage (research.ts) — the ONE thing standing between a caller-directed url and a known
 *  exfiltration/tunnel-provider host (dangerous-domains.ts's own doc comment names the threat this
 *  guards against). Reuses `dangerousDomainMatch`/`SHIPPED_DANGEROUS_DOMAINS` directly — this is a
 *  thin wrapper, never a second matcher.
 *
 *  USER DECISION: "chat mode shouldn't have a plan mode, it simply wouldn't ever ask permissions.
 *  The dangerous urls... would just simply be blocked straight up before the fetch." So this is a
 *  HARD refusal, never a card — unlike `web_fetch` (code mode), whose existing engine.ts approval
 *  card (`webFetchGate`) is COMPLETELY UNCHANGED by this fix; that tool still has (and needs) a
 *  human-in-the-loop path because code mode has one at all. Chat/dispatch structurally don't.
 *
 *  Deliberately does NOT consult a `WebFetch(domain:...)` standing-rule exception (permission-
 *  rules.ts): that rule is minted by a human APPROVING a `web_fetch` card, a consent flow ReadPage/
 *  FetchPage do not have — a rule earned through one tool's approval flow must never silently clear
 *  the OTHER's hard floor that has no such flow to earn it through. `added` is the caller-resolved
 *  "effective list" user-added half (`settings.permissions.dangerousDomains.added`, per project) —
 *  this function takes it as a plain array so it never has to know how to read settings itself; the
 *  one true escape hatch is editing that list, not an in-chat override.
 *
 *  Malformed/unparseable urls (or a url with no resolvable hostname) return `null` — nothing
 *  dangerous can be said about a url with no host, and the caller's own fetch attempt will fail with
 *  its own clear error regardless (nothing reaches the network either way). */
export interface DangerousDomainMatch {
  host: string;
  matchedEntry: string;
}

export function checkDangerousDomain(rawUrl: string, added: readonly string[] = []): DangerousDomainMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  const matchedEntry = dangerousDomainMatch(host, [...SHIPPED_DANGEROUS_DOMAINS, ...added]);
  return matchedEntry ? { host, matchedEntry } : null;
}

/** Shared refusal-text shape for every `checkDangerousDomain` hit, wherever it fires — ReadPage's
 *  own per-entry block (read-page.ts), the research runner's seed/batch blocks (research.ts), AND
 *  (fix round 2, Minor 3 below) fetchCleanPage's own post-redirect re-check. Previously duplicated
 *  ONE COPY EACH in read-page.ts and research.ts (deliberately, since research.ts's own module doc
 *  comment explains why it doesn't import FROM read-page.ts) — moved here since a THIRD copy for
 *  the redirect re-check would be one too many, and both existing callers already depend on this
 *  file for `checkDangerousDomain` itself. Names the entry's url AND the matched list entry, so the
 *  transcript reads as a deliberate policy block, never a network failure. */
export function dangerousDomainRefusal(url: string, match: DangerousDomainMatch, cannotAskReason: string): string {
  return `${url}: refused — ${match.host} matches the dangerous-domain list (${match.matchedEntry}); ${cannotAskReason}`;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // ~1h (USER DESIGN, task-1-brief.md)
const DEFAULT_MAX_ENTRIES = 50;
// Important 3, whole-branch review (2026-07-28): the OLD 20MB total was ~4-5 research-sized (5MB
// cap, web.ts's MAX_FETCH_BYTES) pages, so a single research run could fill nearly the whole cache
// and evict a user's own recently-read page well inside the TTL. Tripled to 60MB — combined with the
// reserved research share just below, research keeps roughly its OLD effective headroom (a full 20MB
// worth, `DEFAULT_RESEARCH_BYTE_SHARE` of the new total) while the user's own reads get a FRESH,
// separate ~40MB share research can never encroach on (see PageCache's own doc comment for the full
// mechanism). This is an in-memory-only cache (module doc comment above) that lives for one chat
// session — a larger ceiling is a pure memory/session-duration tradeoff, not a new persistence risk.
const DEFAULT_MAX_BYTES = 60 * 1024 * 1024;
// Important 3: the FRACTION of `maxBytes` research-tagged entries may occupy AT MOST — see
// PageCache.evict's own doc comment for the guarantee this produces (a research run can push out
// only OTHER research entries, never a "user" one, once this share is full).
const DEFAULT_RESEARCH_BYTE_SHARE = 1 / 3;

/** The two cache-entry origins Important 3's reserved-share eviction discriminates between.
 *  "user" (the default `PageCache.put` assumes when omitted) is a direct `ReadPage` fetch — plain
 *  page reads/citations the user is actively working from. "research" is a fetch the ephemeral
 *  research sub-agent (research.ts, via `FetchPage`) made on its own initiative while exploring
 *  links — potentially many pages per run, and NOT something the user necessarily asked to keep. */
export type PageOrigin = "user" | "research";

/** B2-T3 fix-round-1 CRITICAL: mirrors web.ts's `REQUEST_TIMEOUT_MS` — this module's own fetch
 *  (`followRedirects`, below) used to be called with NO signal at all, so a stuck connection could
 *  hang `fetchCleanPage` (and everything built on it — plain `ReadPage` and the research runner)
 *  forever. Every call now gets a bound by default, combined with (never replaced by) any
 *  caller-supplied signal — a caller that forgets to pass one is still bounded. */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Fixed, small, NAMED seed list (USER DESIGN) — "no ads in the links list," not a full adblocker.
 *  Matched against the RESOLVED link's `hostname`/`pathname` (never a raw substring of the two
 *  concatenated — that let an unrelated page whose PATH merely contained one of these strings,
 *  e.g. `example.com/doubleclick.net.html`, get silently dropped as if it were the ad host itself;
 *  fix round 1, Important). Two entry shapes, both host-scoped:
 *   - a bare host (`doubleclick.net`, `googletagmanager.com`, `google-analytics.com`) matches the
 *     resolved hostname EXACTLY or as a dot-bounded SUBDOMAIN (`stats.doubleclick.net` drops,
 *     `notdoubleclick.net` does not — no bare substring check would tell those two apart);
 *   - `host/path` (`facebook.com/tr`, Meta's pixel-tracking endpoint) matches only the EXACT host
 *     `facebook.com` with a pathname starting `/tr` — scoped this tightly on purpose so it doesn't
 *     drop unrelated facebook.com links, or any other host whose path merely mentions "facebook.com/tr". */
export const AD_TRACKER_LINK_SUBSTRINGS = [
  "doubleclick.net",
  "googletagmanager.com",
  "google-analytics.com",
  "facebook.com/tr",
] as const;

/** See `AD_TRACKER_LINK_SUBSTRINGS`'s doc comment for the two entry shapes this checks.
 *
 *  Whole-branch review, two one-line minors bundled (2026-07-28): (a) the host side now allows the
 *  SAME exact-or-subdomain-suffix match the bare-host entries already get — the earlier fix round's
 *  `host === entryHost` was too strict for `facebook.com/tr` specifically: the REAL Meta Pixel is
 *  served from `www.facebook.com/tr` (verified against Meta's own developer docs), so the exact-host
 *  check silently stopped filtering the very tracker this entry exists for. (b) the path side is now
 *  boundary-aware — `path === entryPath` or a `/`-bounded child of it (`entryPath + "/"` prefix) —
 *  never a bare prefix, which previously dropped `/trending`/`/travel` as false positives just for
 *  starting with the same three characters as `/tr`. */
function isAdTrackerLink(resolved: URL): boolean {
  const host = resolved.hostname.toLowerCase();
  const path = resolved.pathname;
  return AD_TRACKER_LINK_SUBSTRINGS.some((entry) => {
    const slash = entry.indexOf("/");
    if (slash === -1) return host === entry || host.endsWith(`.${entry}`);
    const entryHost = entry.slice(0, slash);
    const entryPath = entry.slice(slash); // keeps the leading "/", e.g. "/tr"
    const hostMatches = host === entryHost || host.endsWith(`.${entryHost}`);
    const pathMatches = path === entryPath || path.startsWith(`${entryPath}/`);
    return hostMatches && pathMatches;
  });
}

export interface CleanPage {
  url: string; // final resolved URL after redirects
  title: string;
  lines: string[]; // deterministic: same input bytes -> identical array
  links: Array<{ href: string; text: string }>; // absolute, deduped, ad/tracker hosts dropped
  fetchedAt: number; // epoch ms (from the injected clock)
  fromCache: boolean;
}

export interface PageCoreDeps {
  fetchFn?: typeof fetch; // injectable; default global fetch
  now?: () => number; // injectable clock for TTL tests
  audit?: (line: Record<string, unknown>) => void;
  /** Audit-line `tool` label — a named obligation from Task 2's review (task-3-brief.md): every
   *  audit line below used to hardcode `tool: "ReadPage"`, which would have mislabeled every fetch
   *  the FetchPage-only research sub-agent (Task 3, agent/research.ts) drives through this SAME
   *  function. Defaults to "ReadPage" so ReadPage's own call sites (read-page.ts's `renderPage`)
   *  are byte-identical without passing this; the research runner passes "FetchPage" instead, so
   *  audit.jsonl can tell the two callers apart. */
  tool?: string;
  /** Caller-supplied abort (e.g. research.ts's own wall-clock deadline signal) — combined
   *  (`AbortSignal.any`) with this function's own default per-fetch timeout below, never a
   *  replacement for it: a caller's signal can only narrow the bound, never widen it past
   *  DEFAULT_FETCH_TIMEOUT_MS (or `timeoutMs`, if overridden). */
  signal?: AbortSignal;
  /** Test-only override of DEFAULT_FETCH_TIMEOUT_MS. Production never sets this — every real
   *  caller is bounded by the fixed 15s default regardless of whether it also passes `signal`. */
  timeoutMs?: number;
  /** Important 3 fix (whole-branch review): the `PageCache.put` origin tag — defaults to "user"
   *  (absent here) so every ReadPage call site (read-page.ts) is byte-identical; the research
   *  runner (research.ts) passes `"research"` explicitly so its OWN fetches ride the reserved byte
   *  share instead of the user's, and can never evict a user's cached page (see PageCache's own doc
   *  comment for the eviction guarantee this produces). */
  origin?: PageOrigin;
  /** Minor 3 fix (whole-branch review, fix round 2): the ALREADY-RESOLVED effective dangerous-
   *  domain list (`SHIPPED_DANGEROUS_DOMAINS` ∪ `settings.permissions.dangerousDomains.added` for
   *  this cwd) — both callers (read-page.ts's `renderPage`/`runResearch`, research.ts's
   *  `runResearch`/`handleFetchPage`) already resolve this exact array ONCE for their own pre-fetch
   *  `checkDangerousDomain(entry.url, ...)` check; passing the SAME array here lets `fetchCleanPage`
   *  re-check the RESOLVED (post-redirect) host too — `checkDangerousDomain` on the CALLER-SUPPLIED
   *  url only catches a url that directly IS a dangerous host, never one that merely redirects INTO
   *  one. Absent → no user additions; the shipped list alone still applies to the redirect re-check
   *  (still fail-safe, just narrower — matches every other dangerousAdded-absent caller's posture). */
  dangerousAdded?: readonly string[];
}

interface CacheEntry {
  page: CleanPage;
  expiresAt: number;
  bytes: number;
  origin: PageOrigin;
}

/** Rough byte weight of a cached page — good enough to govern LRU/byte-cap pressure; not an exact
 *  wire size and never security-relevant (the cap is a memory-hygiene knob, not a trust boundary). */
function estimateBytes(page: CleanPage): number {
  let total = Buffer.byteLength(page.url, "utf8") + Buffer.byteLength(page.title, "utf8");
  for (const line of page.lines) total += Buffer.byteLength(line, "utf8") + 1;
  for (const link of page.links) total += Buffer.byteLength(link.href, "utf8") + Buffer.byteLength(link.text, "utf8");
  return total;
}

/**
 * In-memory ONLY (see module doc comment above for why) TTL+LRU cache of cleaned pages, keyed by
 * the resolved `CleanPage.url`. `get`/`put` never re-clean — storing the CLEANED result (not raw
 * bytes) is exactly what makes a citation's line range stable inside the TTL: two `get`s of the
 * same entry return the SAME `lines` array (see `fetchCleanPage`'s determinism contract).
 *
 * Important 3 fix (whole-branch review): every entry is tagged with a `PageOrigin` ("user" —
 * `put`'s default when the argument is omitted, so every pre-fix call site is byte-identical — or
 * "research"). Eviction runs in THREE passes, all origin-aware: (1) RESEARCH-tagged entries alone
 * are trimmed (oldest-first, among themselves ONLY) until their own running byte total is back
 * under `maxBytes * researchByteShare` — a proactive reservation, independent of whether the
 * overall cap has been reached yet. (2) fix round 2 (whole-branch review, Important — the
 * entry-COUNT trim was origin-BLIND): while EITHER the overall entry count or the overall byte
 * total is still over its cap, evict the oldest RESEARCH-tagged entry — never a "user" one — until
 * research entries run out or both caps are satisfied. (3) only once no research entries remain
 * does the ordinary oldest-first-across-whatever's-left trim run (in practice this can only ever
 * touch "user" entries, since pass 2 removes every research entry before pass 3 could reach one).
 *
 * PREVIOUSLY (fix round 1, corrected by fix round 2): this comment claimed a "user" entry could
 * NEVER be evicted "no matter how many research entries exist" — that guarantee held for BYTES
 * (pass 1) but NOT for entry COUNT, which pass 2 (as it existed then) evicted oldest-first across
 * BOTH tags regardless of origin. Probed on production defaults: 1 user entry + 60 tiny research
 * entries evicted the user's entry purely on COUNT pressure (entries.size 61 > maxEntries 50) with
 * the byte budget nowhere near full — reachable in a single ReadPage call (8 `query` entries x the
 * 15-page research clamp = 120 fetches). Fixed by making pass 2 origin-aware too, so the guarantee
 * below is now actually true in both dimensions, not just the one it used to name.
 *
 * The guarantee this now produces, proven for both dimensions: a "user" entry is evicted ONLY once
 * every "research" entry has already been removed — i.e., only the user's OWN reading activity
 * (too many, or too large, of the user's own cached pages) can ever evict a user entry. No number
 * or size of research-tagged entries can push one out, in either the byte or the entry-count
 * dimension.
 */
export class PageCache {
  private entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly researchByteCap: number;
  private totalBytes = 0;
  private researchBytes = 0;

  constructor(opts?: { ttlMs?: number; maxEntries?: number; maxBytes?: number; researchByteShare?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    this.researchByteCap = this.maxBytes * (opts?.researchByteShare ?? DEFAULT_RESEARCH_BYTE_SHARE);
  }

  get(url: string, now: number): CleanPage | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.entries.delete(url);
      this.totalBytes -= entry.bytes;
      if (entry.origin === "research") this.researchBytes -= entry.bytes;
      return undefined;
    }
    // Refresh recency (LRU): delete + re-insert so this key becomes the most-recently-used —
    // Map iteration order is insertion order, so this is also the LAST key `evict()` would touch.
    // `origin` rides along unchanged — a cache HIT never re-tags an entry (see this class's own doc
    // comment: only `put` decides origin).
    this.entries.delete(url);
    this.entries.set(url, entry);
    return { ...entry.page, fromCache: true };
  }

  /** `origin` defaults to "user" — every call site that existed before Important 3's fix (plain
   *  ReadPage reads via `fetchCleanPage`) passes no origin at all and is byte-identical; only the
   *  research runner passes `"research"` explicitly (see `fetchCleanPage`'s own `deps.origin`). */
  put(page: CleanPage, now: number, origin: PageOrigin = "user"): void {
    const existing = this.entries.get(page.url);
    if (existing) {
      this.totalBytes -= existing.bytes;
      if (existing.origin === "research") this.researchBytes -= existing.bytes;
      this.entries.delete(page.url);
    }
    const bytes = estimateBytes(page);
    this.entries.set(page.url, { page: { ...page, fromCache: false }, expiresAt: now + this.ttlMs, bytes, origin });
    this.totalBytes += bytes;
    if (origin === "research") this.researchBytes += bytes;
    this.evict();
  }

  private evict(): void {
    // Pass 1 — research's OWN reserved BYTE share: trim oldest RESEARCH entries until back under
    // the cap, touching nothing tagged "user" no matter what. Proactive — runs even when the
    // overall entries/bytes caps aren't close to being hit, so research's own footprint never
    // creeps up on the user's reserved headroom.
    if (this.researchBytes > this.researchByteCap) {
      for (const [key, entry] of this.entries) {
        if (this.researchBytes <= this.researchByteCap) break;
        if (entry.origin !== "research") continue;
        this.entries.delete(key);
        this.totalBytes -= entry.bytes;
        this.researchBytes -= entry.bytes;
      }
    }
    // Pass 2 — fix round 2 (whole-branch review, Important): the ordinary combined cap (entries
    // count + overall bytes) used to trim oldest-first across BOTH tags, origin-BLIND — a research
    // run that pushed entries.size (not bytes) over maxEntries could evict a "user" entry even
    // while nowhere near the byte cap (probed: 1 user + 60 tiny research entries on production
    // defaults). Now origin-aware, mirroring pass 1's own preference: evict the oldest RESEARCH
    // entry — never "user" — while either cap is still exceeded, until research entries run out.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      if (entry.origin !== "research") continue;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      this.researchBytes -= entry.bytes;
    }
    // Pass 3 — only once every research entry is gone does a "user" entry become evictable: the
    // ordinary oldest-first trim, now only ever reachable by the user's OWN entries (pass 2 above
    // removes every research-tagged entry before this could touch one, as long as any remain).
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      if (entry.origin === "research") this.researchBytes -= entry.bytes;
    }
  }

  // Critical 2 fold-in (whole-branch review): N identical urls requested CONCURRENTLY (ReadPage's
  // or FetchPage's own batch, up to 8 entries) previously each independently missed this cache (none
  // has resolved yet, so `get` returns undefined for all of them) and fired N separate real fetches
  // — an 8x amplifier on the quadratic-scan bound above. `dedupe` makes every concurrent caller for
  // the SAME url past the first ride the SAME in-flight promise instead. Keyed purely by url,
  // independent of `PageCache`'s TTL/LRU bookkeeping (which only ever sees the ONE eventual result,
  // via the producer's own `cache.put` call inside `fetchCleanPage`) — this map only ever holds
  // promises that are CURRENTLY resolving, never a cached page itself.
  private inFlight = new Map<string, Promise<CleanPage>>();
  // Minor 4 fix (whole-branch review, fix round 2): tracks every ORIGIN any caller has requested
  // for a url's CURRENTLY in-flight fetch — the producer (created by whichever caller happened to
  // be first) reads this back via `getEffectiveOrigin` right before it calls `cache.put`, so the
  // STORED tag reflects every joiner's origin, not just the initiator's. "user" wins over
  // "research" (a stronger claim on protection from eviction never loses to a weaker one).
  private inFlightOrigins = new Map<string, Set<PageOrigin>>();

  /** `producer` receives a `getEffectiveOrigin()` callback (rather than a fixed origin) so it can
   *  read the MERGED origin at the moment it actually calls `cache.put` — any joiner that attached
   *  before that point (even if it started AFTER the producer itself) is reflected. `signal`, if
   *  given, races only a JOINER's own return (see below for why the INITIATOR is deliberately
   *  excluded from that race) — a caller-specific detach, never a cancellation of the shared
   *  underlying fetch itself (which keeps running for every other waiter; see the module-level
   *  `raceAbort` helper's own doc comment). */
  async dedupe(
    url: string,
    origin: PageOrigin,
    producer: (getEffectiveOrigin: () => PageOrigin) => Promise<CleanPage>,
    signal?: AbortSignal,
  ): Promise<CleanPage> {
    const existingOrigins = this.inFlightOrigins.get(url);
    const existingPromise = this.inFlight.get(url);
    if (!existingOrigins || !existingPromise) {
      // The INITIATOR: nothing to join, so this call CREATES the shared producer. Deliberately
      // returned AS-IS, NOT wrapped in `raceAbort` — the initiator's own `signal` is already
      // combined into the real fetch's own AbortSignal INSIDE `producer` (fetchCleanPage's
      // `AbortSignal.any([deps.signal, timeoutSignal])`), which is what produces the nicely
      // classified `PageCoreError(outcome:"timeout", ...)` on abort. Wrapping it in a SECOND,
      // independent race against the identical signal would just race that classification: the
      // outer wrapper's own listener can win first and reject with a generic "aborted" error
      // instead, discarding the more specific one — a real regression this fix must not introduce.
      const origins = new Set<PageOrigin>([origin]);
      this.inFlightOrigins.set(url, origins);
      const promise = producer(() => (origins.has("user") ? "user" : "research")).finally(() => {
        // Only clear OUR OWN entry — a stale delete could otherwise race an already-superseding
        // entry in a pathological reentrant case (not expected here, but this is cheap and
        // unambiguous).
        if (this.inFlight.get(url) === promise) {
          this.inFlight.delete(url);
          this.inFlightOrigins.delete(url);
        }
      });
      this.inFlight.set(url, promise);
      return promise;
    }
    // A JOINER: its own `signal` was never wired into anything before this fix — it simply
    // returned the shared promise verbatim, so an abort had no way to detach it early. `raceAbort`
    // is exactly (and only) that missing detach; the shared `existingPromise` itself is untouched,
    // so the initiator and any OTHER joiners are unaffected.
    existingOrigins.add(origin);
    return raceAbort(existingPromise, signal);
  }
}

/** Races a per-CALLER `signal` against the (possibly SHARED, via `dedupe`) `promise` — if `signal`
 *  fires first, THIS caller's own returned promise rejects promptly; the underlying `promise`
 *  itself is left running untouched (other callers sharing it, via `dedupe`, are unaffected). A
 *  real continuation is always attached to `promise` (never a bare `.catch` swallow), so its
 *  eventual rejection — if the caller already detached via its own signal — is still "handled" and
 *  never surfaces as an unhandled-rejection warning. Minor 4 fix (whole-branch review, fix round
 *  2): before this, EVERY caller of `cache.dedupe` (joiner or not) simply returned the shared
 *  promise directly — a joiner's own abort had no way to detach it from a still-pending shared
 *  fetch; a joiner aborted at 50ms stayed pending until whatever bound the INITIATOR's own signal
 *  happened to be (600ms in the reviewer's probe). */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

// Title extraction used to live here as a byte-identical private copy of web.ts's `extractTitle`,
// deliberately duplicated to avoid exporting a web.ts internal. Task 6b fix-round-1 deleted the copy
// and imports the real one instead (web.ts now `export`s it): both copies carried the SAME quadratic
// `/<h1[^>]*>([\s\S]*?)<\/h1>/i` (review Critical 1, measured 2.8 s per 200 KB of `<h1 x` soup on a
// path reached by every HTML fetch), so the duplication meant two places to fix and two places for
// the next fix to miss. One implementation, one linearity test, one place to be wrong.

// Critical 2, whole-branch review (2026-07-28): the ORIGINAL single combined regex
// (`/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi`, the SAME shape web.ts:98's htmlToText still
// uses — that one is explicitly OUT OF SCOPE for this fix, see extractLinks' own doc comment below)
// is effectively quadratic on many `<a href>` starts with a distant or absent `</a>`: its lazy
// `[\s\S]*?` scans forward hunting for the next `</a>` from EVERY open tag independently, and when
// one is absent (or far away) that scan runs toward end-of-string for EACH open tag. Measured per
// pass: 128KB->169ms, 256KB->652ms, 512KB->2602ms, 1024KB->10470ms (ratios ~3.9-4.0x per doubling —
// clean O(n^2)); a full fetchCleanPage pass over 3MB with no closing tags at all measured 187,667ms.
// Fixed below by scanning opens and closes with two SEPARATE, single-pass regexes (neither has a
// "lazy-scan-to-a-later-required-token" shape) and pairing them with a monotonic pointer walk that
// only ever advances forward across the whole string — O(n) total.
// LINK_OPEN_RE used to live here as a byte-identical copy of web.ts's ANCHOR_OPEN_RE
// (`/<a\s[^>]*href="([^"]+)"[^>]*>/gi`), deliberately duplicated to avoid a reverse dependency.
// Task 6b fix-round-2 deleted it: that regex has THREE nested unbounded quantifiers before a required
// `>` and is CUBIC on the absent-`>` shape (review Critical 2 — 15.5 s per 20 KB, 115 s per 39 KB),
// and because this file carried its own copy the cost was charged TWICE per fetch, once here and once
// in `htmlToText`'s anchor pass. `scanAnchorOpensForLinks` is web.ts's single audited linear scanner;
// see its derivation there. Same de-duplication as `extractTitle` one round earlier, for the same
// reason: two copies of a quadratic means two places to fix and two places for the next fix to miss.
const LINK_CLOSE_RE = /<\/a>/gi; // deliberately NOT `\s*`-tolerant — matches the ORIGINAL combined
// regex's own closing literal exactly (`<\/a>`, no internal whitespace allowance), so this rewrite
// pairs opens with closes identically to before, never accepting a `</a >` the original wouldn't have.

/** Extracts links from RAW html (before `htmlToText`, which rewrites every `<a>` into
 *  `text (href)` prose and so destroys the tag) — the same `<a href="...">...</a>` PAIRING
 *  `htmlToText` itself matches, just scanned in two linear passes instead of one quadratic one (see
 *  the comment above `LINK_OPEN_RE`). Every href is absolute-resolved against `baseUrl` (the FINAL,
 *  post-redirect URL). Drops fragment-only in-page anchors, non-http(s) schemes (`mailto:`,
 *  `javascript:`, ...), and known ad/tracker hosts; dedupes by resolved href, keeping the first
 *  occurrence's anchor text.
 *
 *  Exported ONLY for direct performance testing (page-core.test.ts) — proving THIS function alone is
 *  now linear requires bypassing `fetchCleanPage`'s call to `htmlToText` (web.ts), which has the
 *  IDENTICAL pre-existing quadratic shape and is explicitly OUT OF SCOPE for this fix (branch-fix
 *  report: scope discipline — leave web.ts, file it as a follow-up). Every other caller still goes
 *  through `fetchCleanPage` unchanged.
 *
 *  Behavior-preserving nested-anchor semantics: a `<a>` that opens BEFORE the previously-matched
 *  anchor's own closing tag (malformed nesting) is skipped exactly as the original regex would have
 *  skipped it — the original's own `lastIndex` jumps past a match's FULL span (open through its
 *  matched `</a>`), so a `<a>` inside that span was never separately matched either; it rode along as
 *  literal (later tag-stripped) text inside the OUTER anchor's captured content instead. `consumedUntil`
 *  below reproduces that same behavior. */
export function extractLinks(html: string, baseUrl: string): Array<{ href: string; text: string }> {
  const closes: Array<{ start: number; end: number }> = [];
  {
    let cm: RegExpExecArray | null;
    LINK_CLOSE_RE.lastIndex = 0;
    while ((cm = LINK_CLOSE_RE.exec(html))) closes.push({ start: cm.index, end: cm.index + cm[0].length });
  }

  const seen = new Set<string>();
  const links: Array<{ href: string; text: string }> = [];
  let closePtr = 0; // monotonic — advances forward only across the WHOLE scan, never rewinds
  let consumedUntil = 0; // end of the last matched anchor's closing tag; an open starting before this is "inside" that anchor's span (see doc comment)

  for (const open of scanAnchorOpensForLinks(html)) {
    const openStart = open.start;
    const openEnd = open.end;
    if (openStart < consumedUntil) continue; // nested inside a previously consumed anchor's span

    while (closePtr < closes.length && closes[closePtr]!.start < openEnd) closePtr++;
    if (closePtr >= closes.length) break; // no closing tag anywhere after this open (or any later one) — nothing more can match

    const close = closes[closePtr]!;
    closePtr++;
    consumedUntil = close.end;

    const rawHref = open.capture;
    if (!rawHref || rawHref.startsWith("#")) continue; // in-page anchor only, never a real link
    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue; // unparsable href — skip rather than fail the whole page
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue; // mailto:, javascript:, ...
    if (isAdTrackerLink(resolved)) continue;
    const href = resolved.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const inner = html.slice(openEnd, close.start);
    const text = htmlToText(inner).replace(/\n+/g, " ").trim();
    links.push({ href, text });
  }
  return links;
}

/** Structured error thrown by `fetchCleanPage` — `outcome` is web.ts's exact vocabulary
 *  (`ssrf_refused`/`timeout`/`http_error`/`network_error`/`parse_error`), attached as a real field
 *  rather than left for callers to re-derive from the message text. Mirrors web.ts's own local
 *  `outcome` variable, just carried on the thrown error since this module has no `run()`/audit
 *  closure of its own to keep it in. */
export class PageCoreError extends Error {
  constructor(
    message: string,
    public readonly outcome: string,
  ) {
    super(message);
    this.name = "PageCoreError";
  }
}

/**
 * Fetch + clean + link-extract a page, serving a cached CLEANED copy inside the TTL instead of
 * re-fetching or re-cleaning. That is the determinism contract: a citation `url lines:N-M` must
 * re-resolve to the same text later, which only holds if the SAME cleaned `lines` array is served
 * every time inside the cache window — never a fresh re-clean of possibly-changed live bytes.
 *
 * Cache key nuance: `cache.get`/`cache.put` are keyed by `CleanPage.url` (the FINAL, resolved
 * address) — for a `url` that doesn't redirect, that's identical to what's passed in here, so
 * repeat calls with the same string hit the cache. For a `url` that DOES redirect, a repeat call
 * with the original (pre-redirect) address will still refetch; a repeat call with the previously
 * RETURNED (resolved) address — exactly what a citation cites and a later `ReadPage` call would
 * pass — hits the cache. This matches the one property that matters here: citations stay stable.
 */
export async function fetchCleanPage(url: string, cache: PageCache, deps: PageCoreDeps = {}): Promise<CleanPage> {
  const now = deps.now?.() ?? Date.now();

  const tool = deps.tool ?? "ReadPage";

  const cached = cache.get(url, now);
  if (cached) {
    deps.audit?.({ kind: "network", tool, url, outcome: "ok", fromCache: true });
    return cached;
  }

  // Critical 2 fold-in (whole-branch review): everything past the cache-miss check is wrapped in
  // `cache.dedupe` — see PageCache.dedupe's own doc comment. A single caller (no concurrent
  // duplicate in flight) is unaffected: `dedupe` just runs `producer` once, same as before this fix.
  //
  // Minor 4 fix (whole-branch review, fix round 2): `deps.origin ?? "user"` is THIS caller's own
  // origin claim (merged with every other joiner's inside `dedupe`, "user" always winning); `getEffectiveOrigin`
  // is read at `cache.put` time below, not captured up front, so a LATER joiner's origin still
  // counts. `deps.signal` (this caller's OWN raw signal, before it gets combined with the default
  // timeout just below) races only THIS caller's own return — a joiner that aborts detaches
  // promptly without affecting the shared fetch other callers are waiting on.
  return cache.dedupe(url, deps.origin ?? "user", async (getEffectiveOrigin) => {
    // fix-round-1 CRITICAL: always bounded, even when `deps.signal` is absent — see
    // DEFAULT_FETCH_TIMEOUT_MS's own doc comment.
    const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    const signal = deps.signal ? AbortSignal.any([deps.signal, timeoutSignal]) : timeoutSignal;

    // fix-round-2 IMPORTANT (upgraded from a reviewer Minor): web.ts's followRedirects only wraps
    // its OWN initial fetchFn() call in a try/catch — the body read (readCapped, web.ts's own
    // followRedirects, called AFTER that try/catch closes) runs unguarded, so a timeout that fires
    // AFTER headers arrive but DURING the body read escaped followRedirects (and, with no try/catch
    // here either, escaped fetchCleanPage too) as a raw, unclassified error — no PageCoreError, no
    // outcome, and (since the throw skipped every line below) NO AUDIT LINE for a fetch that
    // genuinely reached the network. Preferred the page-core-local fix over moving readCapped inside
    // followRedirects' own try (which would edit web.ts, shared by web_fetch/Search — web_fetch
    // doesn't have this hole because its OWN try wraps the whole followRedirects call already, the
    // same shape this now mirrors): whatever escapes the call, classify it with followRedirects' own
    // AbortError/TimeoutError -> "timeout" vocabulary and audit it before rethrowing as a PageCoreError.
    let res: Awaited<ReturnType<typeof followRedirects>>;
    try {
      res = await followRedirects(url, { fetchFn: deps.fetchFn, signal });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const outcome = name === "AbortError" || name === "TimeoutError" ? "timeout" : "network_error";
      const message = outcome === "timeout" ? `request timed out fetching ${url}` : `fetch failed: ${e instanceof Error ? e.message : String(e)}`;
      deps.audit?.({ kind: "network", tool, url, outcome });
      throw new PageCoreError(message, outcome);
    }
    if (!res.ok) {
      const outcome =
        res.kind === "ssrf"
          ? "ssrf_refused"
          : res.kind === "timeout"
            ? "timeout"
            : res.kind === "redirects"
              ? "too_many_redirects"
              : res.kind === "http"
                ? "http_error"
                : "network_error";
      deps.audit?.({ kind: "network", tool, url, outcome });
      throw new PageCoreError(res.error, outcome);
    }

    // Minor 3 fix (whole-branch review, fix round 2): checkDangerousDomain only ever ran on the
    // CALLER-SUPPLIED url, before this function was even invoked (read-page.ts's renderPage/
    // runResearch, research.ts's runResearch/handleFetchPage) — a SAFE url that redirects INTO a
    // dangerous host sailed through untouched (probed: ReadPage("https://safe.example/go") -> 302
    // -> https://transfer.sh/dropped fetched and rendered, isError:false). Can't undo the network
    // egress that already happened (matches webFetchGate's own documented limit — the first hop
    // already carried whatever the model put in the URL), but this stops the dangerous host's
    // CONTENT from ever reaching the model or the cache: re-check the RESOLVED (post-redirect) host
    // here, using the SAME already-resolved effective list the caller used for its own check.
    const redirectedDangerous = checkDangerousDomain(res.url, deps.dangerousAdded ?? []);
    if (redirectedDangerous) {
      deps.audit?.({ kind: "network", tool, url, outcome: "dangerous_domain_redirect" });
      throw new PageCoreError(
        dangerousDomainRefusal(
          res.url,
          redirectedDangerous,
          "no approval flow exists to ask for one, so a redirect into a known exfiltration/tunnel-provider host is blocked outright",
        ),
        "dangerous_domain_redirect",
      );
    }

    let page: CleanPage;
    try {
      const isHtml = res.contentType.toLowerCase().includes("text/html");
      // Non-HTML path: htmlToText (the HTML path) already trims each line, which incidentally drops
      // a trailing "\r" too — the raw-text path has no such step, so a CRLF body (any .txt/code
      // fetch) would otherwise leak "\r" onto every line but the last (fix round 1, Minor).
      const cleanedText = isHtml ? htmlToText(res.body) : res.body.replace(/\r\n/g, "\n");
      const title = isHtml ? extractTitle(res.body) : "-";
      const links = isHtml ? extractLinks(res.body, res.url) : [];
      page = { url: res.url, title, lines: cleanedText.split("\n"), links, fetchedAt: now, fromCache: false };
    } catch (e) {
      deps.audit?.({ kind: "network", tool, url, outcome: "parse_error" });
      throw new PageCoreError(`could not parse page content: ${e instanceof Error ? e.message : String(e)}`, "parse_error");
    }

    cache.put(page, now, getEffectiveOrigin());
    deps.audit?.({ kind: "network", tool, url, outcome: "ok", fromCache: false });
    return page;
  }, deps.signal);
}

/** Numbered `N→text` rendering (1-based line numbers), the whole page when no range is given.
 *  Out-of-bounds/inverted `lineStart`/`lineEnd` clamp to `[1, lines.length]` and the header says so
 *  — reporting both the requested and the actually-rendered range — rather than silently returning
 *  an empty result or throwing on a caller's stale/miscounted range. */
export function renderLines(page: CleanPage, lineStart?: number, lineEnd?: number): string {
  const total = page.lines.length;
  if (total === 0) return `${page.title} (0 lines)`;

  const reqStart = lineStart ?? 1;
  const reqEnd = lineEnd ?? total;
  const start = Math.min(Math.max(Math.trunc(reqStart), 1), total);
  const end = Math.min(Math.max(Math.trunc(reqEnd), start), total);
  const clamped = start !== reqStart || end !== reqEnd;

  const body: string[] = [];
  for (let i = start; i <= end; i++) body.push(`${i}→${page.lines[i - 1]}`);

  const header = clamped
    ? `${page.title} (lines ${start}-${end} of ${total} — requested ${reqStart}-${reqEnd}, clamped)`
    : `${page.title} (lines ${start}-${end} of ${total})`;

  return [header, ...body].join("\n");
}
