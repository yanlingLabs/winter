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

const LOCAL_REFUSAL = `refusing to fetch a local address`;
const PRIVATE_REFUSAL = `refusing to fetch a private address`;

/** First-two-octets private/loopback/link-local IPv4 table — shared by literal IPv4 hosts
 *  (`10.0.0.1`) AND IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1` / its canonical hex form
 *  `::ffff:a00:1`), which resolve to the exact same 32-bit address and must not evade the guard
 *  just because they're spelled as IPv6. */
function ipv4Refusal(a: number, b: number): string | null {
  if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return PRIVATE_REFUSAL;
  }
  return null;
}

/** A bare IPv4 HOST. `0.0.0.0` is reported as *local* rather than *private* because that's the
 *  string this guard has always reported for it (it used to be an explicit `h === "0.0.0.0"` check
 *  in the local-names branch, ahead of the numeric table) — and WHATWG canonicalizes `http://0/` to
 *  exactly that host, so the distinction is reachable from a non-canonical spelling too. */
function ipv4HostRefusal(bits: number): string | null {
  if (bits === 0) return LOCAL_REFUSAL;
  return ipv4Refusal((bits >>> 24) & 0xff, (bits >>> 16) & 0xff);
}

/** `inet_aton`/WHATWG's radix rules (`0x…` hex, a leading `0` octal, else decimal) vs. every part
 *  read as DECIMAL regardless of a leading zero — the reading Darwin's resolver takes whenever the
 *  host is a four-part all-decimal quad. See `ipv4Interpretations` for why both are consulted. */
type RadixPolicy = "c-convention" | "decimal-only";

/** One dotted part under one radix policy, or `null` when it isn't a legal part at all.
 *
 *  ASCII digits only: JS's `\d` is already ASCII-only without the `u` flag, and these explicit
 *  classes keep it that way if the pattern is ever ported. Values are read as doubles — exact below
 *  2^53 and, above it, only ever rounded by a relative epsilon, so a value that is ≥ 2^32 can never
 *  round DOWN across the width checks in `dottedIPv4`. Overflow therefore fails the parse rather
 *  than wrapping (see that function's comment for why wrapping is the thing to avoid). */
function parsePart(part: string, policy: RadixPolicy): number | null {
  if (part === "") return null;
  if (policy === "c-convention") {
    if (part.startsWith("0x") || part.startsWith("0X")) {
      const digits = part.slice(2);
      if (digits === "") return 0; // WHATWG reads a bare `0x` as zero
      if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
      return Number.parseInt(digits, 16);
    }
    if (part.length > 1 && part.startsWith("0")) {
      const digits = part.slice(1);
      if (!/^[0-7]+$/.test(digits)) return null;
      return Number.parseInt(digits, 8);
    }
  }
  if (!/^[0-9]+$/.test(part)) return null;
  return Number(part);
}

/** `inet_aton`'s grammar, parsed exactly: 1-4 parts with the classic widening (`a` / `a.b` /
 *  `a.b.c` / `a.b.c.d`), every part but the last capped at a byte and the last filling the rest.
 *
 *  EXPLICIT WIDTH CHECKS, and that is the point (fix-round-2 finding on the Swift port, back-ported
 *  here): the platform `inet_aton` silently WRAPS on overflow instead of failing — `0x1c0a80101`
 *  (2^32 + 0xc0a80101) reads as 192.168.1.1, `4294967296` as 0.0.0.0. A wrapped value is
 *  indistinguishable from a real parse and invents addresses the string never denoted, so overflow
 *  fails the parse here instead. */
function dottedIPv4(host: string, policy: RadixPolicy): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    const value = parsePart(part, policy);
    if (value === null) return null;
    values.push(value);
  }

  const tailBits = (5 - values.length) * 8; // 1 part → 32, 2 → 24, 3 → 16, 4 → 8
  const tail = values[values.length - 1]!;
  if (tail >= 2 ** tailBits) return null;
  let bits = tail;
  for (let i = 0; i < values.length - 1; i++) {
    const value = values[i]!;
    if (value > 255) return null;
    bits += value * 2 ** (32 - 8 * (i + 1));
  }
  return bits >>> 0; // the width checks above already bound this to 32 bits
}

/** Every 32-bit address this host string could denote to something that will dial it. Empty when the
 *  host is not an IPv4 literal under any reading.
 *
 *  WHY TWO READINGS. `inet_aton`/WHATWG and `getaddrinfo` — the resolver — disagree, and neither is
 *  a superset of the other. Measured on this machine:
 *
 *      host             inet_aton/WHATWG   getaddrinfo    private?
 *      0300.0250.0.1    192.168.0.1        192.168.0.1    yes  (octal; both agree)
 *      0xc0a80101       192.168.1.1        192.168.1.1    yes  (hex; both agree)
 *      010.0.0.1        8.0.0.1            10.0.0.1       yes — ONLY under getaddrinfo
 *      0177.0.0.1       127.0.0.1          177.0.0.1      yes — ONLY under inet_aton/WHATWG
 *
 *  `getaddrinfo` reads a leading zero as DECIMAL (`010` → 10) where `inet_aton` takes the C
 *  convention (`010` → 8). A guard consulting either alone fails OPEN on one of those two rows, so
 *  both are returned and ANY private reading refuses. That is fail-closed by construction and costs
 *  nothing: a genuinely public address is public under both readings.
 *
 *  DARWIN'S ACTUAL RULE, since the obvious guess is wrong and the wrong guess was in this comment
 *  until the review corrected it: it is not per-part. `getaddrinfo` tries a STRICT FOUR-PART
 *  ALL-DECIMAL parse first (leading zeros allowed, every part ≤ 255) and falls back to whole-host
 *  `inet_aton` when that fails — never a mix. Measured:
 *
 *      host              new URL        getaddrinfo    inet_aton
 *      010.0.0.1         8.0.0.1        10.0.0.1       8.0.0.1      4 parts: the decimal quad wins
 *      010.0.1           8.0.0.1        8.0.0.1        8.0.0.1      3 parts: no quad, so C convention
 *      0172.020.0300.1   122.16.192.1   122.16.192.1   122.16.192.1 quad FAILS (300 > 255) → aton
 *      0172.020.192.1    122.16.192.1   172.20.192.1   122.16.192.1 quad succeeds
 *
 *  `decimal-only` ∪ `c-convention` is a strict SUPERSET of that rule for every part count — which is
 *  the fail-closed property this needs, and it is what makes the mechanism correction a comment fix
 *  rather than a code fix. Checked empirically, not by argument: a 46,598-host mixed-radix corpus
 *  (including the `0172.020.0300.1` shape built specifically to break it) found 0 resolver holes and
 *  0 dial holes. `test/agent/tools/ssrf-resolver-sweep.test.ts` carries the transform that keeps a
 *  regression here visible. */
function ipv4Interpretations(host: string): number[] {
  const found: number[] = [];
  for (const policy of ["c-convention", "decimal-only"] as const) {
    const bits = dottedIPv4(host, policy);
    if (bits !== null && !found.includes(bits)) found.push(bits);
  }
  return found;
}

/** WHATWG's strict IPv4-in-IPv6 tail: exactly four 1-3 digit decimal parts, no leading zeros, each
 *  ≤ 255. Deliberately NOT `dottedIPv4` — inside an IPv6 literal there is no `inet_aton` widening
 *  and no alternate radix, in either WHATWG's parser or `inet_pton`'s. */
function strictDottedQuad(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let bits = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    bits = bits * 256 + value;
  }
  return bits >>> 0;
}

/** The 16 bytes of an IPv6 literal (unbracketed, lowercased), or `null` when the host is not one.
 *  A zone id (`%en0`) is stripped first: a resolver honours scoped link-local addresses, so the
 *  guard has to see through the suffix rather than let it disguise `fe80::1`.
 *
 *  This is what structurally retires the old `wasIpv6Literal` gate: a host that merely LOOKS like an
 *  IPv6 prefix (`fcc.gov`, `fdic.gov`, `fear.com`) simply fails to parse and never reaches a
 *  prefix check at all, so the over-blocking class is impossible rather than conditionally avoided. */
function ipv6Bytes(host: string): Uint8Array | null {
  const bare = host.split("%")[0]!;
  if (!bare.includes(":")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const groupsOf = (text: string): number[] | null => {
    if (text === "") return [];
    const labels = text.split(":");
    const groups: number[] = [];
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      if (i === labels.length - 1 && label.includes(".")) {
        const quad = strictDottedQuad(label);
        if (quad === null) return null;
        groups.push((quad >>> 16) & 0xffff, quad & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(label)) return null;
      groups.push(Number.parseInt(label, 16));
    }
    return groups;
  };

  const head = groupsOf(halves[0]!);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tail = groupsOf(halves[1]!);
    if (tail === null) return null;
    if (head.length + tail.length > 7) return null; // "::" must elide at least one group
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

/** Numeric range checks over the parsed 16 bytes — the whole-nibble `startsWith("fc")` /
 *  first-hextet arithmetic this replaces was correct only for the canonical spelling. */
function ipv6Refusal(bytes: Uint8Array): string | null {
  if (bytes.every((b) => b === 0)) return LOCAL_REFUSAL; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return LOCAL_REFUSAL; // ::1

  // IPv4-mapped (`::ffff:a.b.c.d`, and its canonical hex form `::ffff:XXXX:YYYY`) is a real IPv4
  // address and must go through the SAME table — the textbook v4-blocklist bypass. Deliberately
  // `ipv4Refusal` and not `ipv4HostRefusal`, preserving this guard's long-standing behavior that
  // `::ffff:0.0.0.0` is *private* (first octet 0) rather than *local*.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const refusal = ipv4Refusal(bytes[12]!, bytes[13]!);
    if (refusal) return refusal;
  }

  if ((bytes[0]! & 0xfe) === 0xfc) return PRIVATE_REFUSAL; // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return PRIVATE_REFUSAL; // fe80::/10 — wider than fe80::/16
  return null;
}

/** One host string — canonical or as-written — judged on its own. */
function hostRefusal(host: string): string | null {
  let h = host.toLowerCase();
  // Trailing-dot FQDN normalization: "localhost." / "10.0.0.1." are the SAME address as their
  // dot-less forms (a trailing dot is just the DNS root label) but defeat every check below if left
  // as-is. Strip ONE trailing dot.
  if (h.endsWith(".")) h = h.slice(0, -1);
  // IPv6 literals arrive bracketed from URL.hostname ("[fe80::1]") — unwrap BEFORE any check.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "") return null;

  // Names, not addresses — the one branch that stays a string comparison, because there is nothing
  // to parse.
  if (h === "localhost" || h.endsWith(".local")) return LOCAL_REFUSAL;

  // IPv6 is resolved FIRST and completely: an IPv6 literal is unambiguously an address, so the IPv4
  // readings below must never look at it (`::ffff:1.1.1.1` splits on "." into parts that are not
  // IPv4 parts at all, and a partial reading of an address is worse than none).
  const bytes = ipv6Bytes(h);
  if (bytes) return ipv6Refusal(bytes);

  // ANY reading that lands in private space refuses.
  for (const bits of ipv4Interpretations(h)) {
    const refusal = ipv4HostRefusal(bits);
    if (refusal) return refusal;
  }
  return null;
}

/** The host EXACTLY AS WRITTEN in `raw`, before WHATWG's canonicalizer rewrote it — lowercased and
 *  percent-decoded, with userinfo and port removed. `null` when there is no authority to extract.
 *
 *  This exists because `ssrfGuard` has to judge a spelling that `new URL()` has already thrown away.
 *  See the guard's own comment for the fail-open class it closes. Everything WHATWG does to a URL
 *  BEFORE the host parser runs is reproduced here — tab/newline removal, C0-control-or-space
 *  trimming, `\` treated as `/` (special schemes only, which is all this guard accepts), an
 *  arbitrary run of leading slashes, userinfo up to the LAST `@`, and percent-decoding — and
 *  nothing it does after. It is deliberately CONTAINED: a mis-extraction can only produce a host
 *  that no reading recognises (in which case the canonical check, which is what this guard has
 *  always done, still stands unchanged), never a weaker verdict than before.
 *
 *  The UTS-46 MAPPING step (review Minor 1) is the last thing WHATWG does before parsing the host,
 *  and skipping it let six measured spellings of the ambiguous class walk straight past this leg:
 *  `０１０.0.0.1` (FULLWIDTH DIGIT ZERO/ONE), its percent-encoded UTF-8 form
 *  `%EF%BC%90%EF%BC%91%EF%BC%90.0.0.1`, `０１２７.0.0.1`, and `010。0.0.1` / `010．0.0.1` /
 *  `010｡0.0.1` (U+3002 IDEOGRAPHIC, U+FF0E FULLWIDTH and U+FF61 HALFWIDTH IDEOGRAPHIC FULL STOP —
 *  UTS-46 folds all three to `.`). `NFKC` covers the fullwidth digits and U+FF0E, and folds U+FF61 to
 *  U+3002; U+3002 is itself NFKC-stable, so it is folded explicitly. Order matters: percent-decode
 *  first (those escapes ARE the UTF-8 of those characters), then normalize, then fold, then
 *  lowercase. This is the mapping step only, not a reimplementation of IDNA — Punycode conversion
 *  cannot turn a host into a private IPv4 literal, so it buys nothing here. */
function rawAuthorityHost(raw: string): string | null {
  let rest = raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  const scheme = /^[A-Za-z][A-Za-z0-9+\-.]*:/.exec(rest);
  if (!scheme) return null;
  rest = rest.slice(scheme[0].length).replace(/^[/\\]*/, "");
  const authorityEnd = rest.search(/[/\\?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf("@");
  let host = at === -1 ? authority : authority.slice(at + 1);
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close !== -1) host = host.slice(0, close + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  if (host === "") return null;
  try { host = decodeURIComponent(host); } catch { /* not valid UTF-8 escapes — judge it as written */ }
  return host.normalize("NFKC").replace(/\u3002/g, ".").toLowerCase();
}

/** Norma's ONLY sanctioned network egress (spec 4g §4.3) — bash stays sandboxed (network denied).
 *  v1 SSRF posture: literal private/loopback/link-local hosts rejected; DNS-rebinding is out of
 *  scope (documented). Response bytes are DATA, never instructions.
 *
 *  ## Why this PARSES addresses instead of string-matching them, and why it judges TWO hosts
 *
 *  Until this rewrite every check here was a string comparison (`h === "127.0.0.1"`, a dotted-quad
 *  regex, `h.startsWith("fc")`) against `u.hostname` — i.e. against the host AFTER WHATWG's
 *  canonicalizer had rewritten it. That is load-bearing and it is also where the hole was:
 *  canonicalization is LOSSY, and the reading WHATWG picks is not the only reading a resolver will
 *  accept. `getaddrinfo("0127.0.0.1")` is 127.0.0.1 — loopback — while WHATWG reads the leading zero
 *  as octal and hands the guard `87.0.0.1`, which is public, so the guard said yes. The class is
 *  unbounded (leading zeros repeat: `00127`, `000127`, …) and reachable percent-encoded
 *  (`%30%31%32%37.0.0.1`), so it is a class to close, not a list to enumerate.
 *
 *  So both hosts are judged, and any private reading of either refuses:
 *
 *  1. `u.hostname` — the CANONICAL host. On this runtime it is also the DIALED host: Bun's `fetch`
 *     runs the URL through the same WHATWG parser and connects to the canonicalized authority
 *     (verified with a loopback probe — `http://0177.0.0.1:PORT/` reaches a listener bound to
 *     127.0.0.1, i.e. WHATWG's octal reading, and arrives with `Host: 127.0.0.1:PORT`). The
 *     resolver sweep asserts this leg separately, because a hole in it would be a live SSRF rather
 *     than a latent one.
 *  2. `rawAuthorityHost(raw)` — the host AS WRITTEN, under BOTH radix readings (see
 *     `ipv4Interpretations`). This is the leg that closes the class above, and it is what keeps the
 *     daemon's verdict identical to the phone's (`apple/NormaChatKit/.../SSRFGuard.swift`, whose
 *     `Foundation.URL` canonicalizes nothing and so has always had to parse).
 *
 *  This only ever TIGHTENS: every host the old string checks refused is still refused, with the same
 *  message. The deliberate new refusals are the ambiguous spellings — `http://010.0.0.1/`,
 *  `http://0127.0.0.1/`, `http://010.010.010.010/` — which WHATWG would dial as public addresses but
 *  a resolver handed the same string targets into private space. No legitimate host is spelled that
 *  way, and `test/agent/tools/ssrf-resolver-sweep.test.ts` is the generator-independent gate that
 *  proves nothing the guard allows resolves — or dials — into private space. */
export function ssrfGuard(raw: string): string | null {
  let u: URL; try { u = new URL(raw); } catch { return `invalid url: ${raw}`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `only http(s) urls are allowed`;

  const canonical = u.hostname.toLowerCase();
  const canonicalRefusal = hostRefusal(canonical);
  if (canonicalRefusal) return canonicalRefusal;

  const written = rawAuthorityHost(raw);
  if (written !== null && written !== canonical) {
    const writtenRefusal = hostRefusal(written);
    if (writtenRefusal) return writtenRefusal;
  }
  return null;
}

// Whole-branch review, Critical 2 follow-up (fix round 2): the five regexes below used to be the
// textbook lazy-scan-to-a-required-later-token shape (`<script[\s\S]*?<\/script>`, and its
// siblings for style/head/h1-h6/a) that page-core.ts's `extractLinks` was ALREADY fixed for (see
// that file's own comment on `LINK_OPEN_RE`/`LINK_CLOSE_RE`) — but `htmlToText` itself, called
// UNCONDITIONALLY on every HTML page `fetchCleanPage` (and `web_fetch`) fetches, still had the
// identical shape in five places. Each `[\s\S]*?` rescans forward from EVERY open tag hunting for
// its own closing token; with many opens and a distant/absent close, that is O(n^2) — and unlike
// `extractLinks` (only reached when a page's LINKS are being extracted), `htmlToText` runs on the
// FULL byte count of every HTML fetch, so this was the dominant cost (page-core.test.ts's own
// comment on `extractLinks`'s "20,000 opens + 1 distant close" case measured 3836ms even with
// `extractLinks` itself fixed — entirely from this function). Replaced with the same technique
// `extractLinks` uses: opens and closes scanned SEPARATELY (single-pass regexes, neither with a
// lazy-scan-to-a-later-token shape) and paired by a monotonic pointer that only advances forward —
// O(n) total. `replacePairedTag` below is the shared mechanism for the four SAME-tag-name cases
// (script/style/head/anchor); headings need their own `convertHeadings` because the original
// regex's `\1` backreference means an `<h2>` open must pair with the SAME level's `</h2>` close,
// not any heading level's — six independent per-level pointers, one shared "already consumed"
// cursor (so a heading nested inside an already-matched span of ANY level is skipped, exactly like
// the original combined regex's own lastIndex-jump behavior).
// Deliberately BARE tokens (no `[^>]*>` requirement) for script/style/head — matching the ORIGINAL
// regex's own shape exactly: `<script[\s\S]*?<\/script>` never required its OWN opening tag to be
// terminated by a `>` at all (unlike headings/anchors below, whose original patterns DID require
// `[^>]*>`); the lazy `[\s\S]*?` scans past ANY characters, including a stray `>` that happens to
// belong to some other, unrelated markup, hunting only for the literal "</script>" text. A
// differential fuzz run (html-to-text-differential.test.ts) caught a real byte-divergence class
// from getting this wrong: an EARLIER version of this fix used `/<script[^>]*>/gi` here (mirroring
// headings/anchors), which on deeply malformed input (an unterminated `<script` whose "own" `>`
// turned out to belong to some LATER unrelated tag) paired differently than the original's
// tag-oblivious lazy scan. Using the bare token instead reproduces the original's exact behavior,
// including its own over-matching quirk (a tag merely STARTING WITH "script" also counts — the
// original has the identical quirk, so this is faithful, not a regression).
//
// EXACTNESS CAVEAT (closing review, independent fuzz): the script/style/head passes above are
// byte-exact vs the original (0/40k adversarial), but TWO divergence classes exist elsewhere in
// this rewrite, BOTH confined to malformed HTML and NOT reachable from realistic pages
// (0 divergence across 13k realistic-shaped fuzz cases + a 20-doc corpus + 5/5 byte-identical
// fixtures through the real web_fetch tool):
//   (A) headings — an open like `<h3<h2>` whose `[^>]*` swallowed a later heading open: the
//       original's combined regex could backtrack into the open tag's own parse to satisfy the
//       trailing close; the linear two-pass scan cannot. This is the PRICE OF LINEARITY, not a
//       fixable bug: restoring exact old semantics (retry at openStart+1) re-introduces the
//       quadratic (~7.7 s at 256KB of `<h1` soup vs ~0.8 ms linear).
//   (B) anchors — pathological `href` values like `<a href="href=">` pair differently for the
//       same backtracking reason.
// Do not "fix" either by reverting to combined lazy regexes — that reopens the daemon-freezing
// DoS this rewrite exists to close (a model-chosen URL froze the event loop ~58 s per 3MB page).
const SCRIPT_OPEN_RE = /<script/gi;
const SCRIPT_CLOSE_RE = /<\/script>/gi;
const STYLE_OPEN_RE = /<style/gi;
const STYLE_CLOSE_RE = /<\/style>/gi;
const HEAD_OPEN_RE = /<head/gi;
const HEAD_CLOSE_RE = /<\/head>/gi;
// Same open/close shape as page-core.ts's own LINK_OPEN_RE/LINK_CLOSE_RE (deliberately NOT
// imported — that would be a reverse dependency, since page-core.ts already imports FROM this
// file; a tiny disclosed duplication, same precedent as this file's own `extractTitle`/page-core's
// separate copy).
const ANCHOR_OPEN_RE = /<a\s[^>]*href="([^"]+)"[^>]*>/gi;
const ANCHOR_CLOSE_RE = /<\/a>/gi;
const HEADING_OPEN_RE = /<h([1-6])[^>]*>/gi;
const HEADING_CLOSE_RE = /<\/h([1-6])>/gi;

/** Linear (single monotonic pass) equivalent of
 *  `html.replace(new RegExp(openSrc + "[\\s\\S]*?" + closeSrc, "gi"), render)` — see the comment
 *  above this function's call sites for why. `openRe`/`closeRe` must both carry the `g` flag (their
 *  `lastIndex` is reset and driven internally). Every open tag pairs with the FIRST closing tag
 *  found anywhere after it; an open tag starting before the previously-matched pair's own close is
 *  treated as nested/already-consumed (left as literal text, never separately matched) — the same
 *  behavior the original lazy regex's own `lastIndex` jump produces (it never separately matches a
 *  tag nested inside an already-consumed span either). An open tag with no closing tag anywhere
 *  after it (and every later open, once closes are exhausted) is left as literal text, matching the
 *  original regex's own "no match" outcome for that case. */
function replacePairedTag(
  html: string,
  openRe: RegExp,
  closeRe: RegExp,
  render: (openMatch: RegExpExecArray, inner: string) => string,
): string {
  const closes: Array<{ start: number; end: number }> = [];
  closeRe.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = closeRe.exec(html))) closes.push({ start: cm.index, end: cm.index + cm[0].length });

  let out = "";
  let cursor = 0;
  let closePtr = 0;
  openRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const openStart = m.index;
    const openEnd = openRe.lastIndex;
    if (openStart < cursor) continue; // nested inside a previously-consumed span

    while (closePtr < closes.length && closes[closePtr]!.start < openEnd) closePtr++;
    if (closePtr >= closes.length) break; // no closing tag anywhere after this open (or any later one)

    const close = closes[closePtr]!;
    closePtr++;
    out += html.slice(cursor, openStart);
    out += render(m, html.slice(openEnd, close.start));
    cursor = close.end;
  }
  out += html.slice(cursor);
  return out;
}

/** `<h1-6>...</h(SAME LEVEL)>` — the one shape `replacePairedTag` can't handle directly, since the
 *  original regex's `\1` backreference requires the CLOSE to be the same level as its OPEN. Six
 *  independent per-level close-position lists (one linear scan total, bucketed by level) and six
 *  independent per-level pointers, but ONE shared `cursor` across all levels — an open (of ANY
 *  level) nested inside an already-matched span (of ANY level) is skipped, matching the original
 *  combined regex's own behavior. An open whose OWN level has no more available closes is left as
 *  literal (matching the original's "no match at this position" outcome) and scanning continues —
 *  unlike `replacePairedTag`'s single-tag `break`, exhausting one level's closes does not mean
 *  another level's opens can no longer match, so this never early-exits the whole scan. */
function convertHeadings(html: string): string {
  const closesByLevel: Record<string, number[]> = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [] };
  HEADING_CLOSE_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = HEADING_CLOSE_RE.exec(html))) closesByLevel[cm[1]!]!.push(cm.index);

  const ptrs: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0 };
  let out = "";
  let cursor = 0;
  HEADING_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_OPEN_RE.exec(html))) {
    const level = m[1]!;
    const openStart = m.index;
    const openEnd = HEADING_OPEN_RE.lastIndex;
    if (openStart < cursor) continue;

    const list = closesByLevel[level]!;
    let p = ptrs[level]!;
    while (p < list.length && list[p]! < openEnd) p++;
    ptrs[level] = p;
    if (p >= list.length) continue; // this level's closes are exhausted — literal text, keep scanning (other levels may still match)

    const closeStart = list[p]!;
    ptrs[level] = p + 1;
    out += html.slice(cursor, openStart);
    const inner = html.slice(openEnd, closeStart);
    out += `\n${"#".repeat(Number(level))} ${inner}\n`;
    cursor = closeStart + `</h${level}>`.length;
  }
  out += html.slice(cursor);
  return out;
}

const LT = 0x3c; // "<"
const GT = 0x3e; // ">"

/** `/<li\b[^>]*>/gi`'s OPEN token only. `(?![0-9A-Za-z_])` is exactly the original's `\b`: the
 *  preceding character is always `i`, a JS word character, so the boundary holds iff the next
 *  character is a non-word one (or the string ends — where the original then fails for want of a `>`,
 *  as does the scan below). No unbounded quantifier, so driving this with `exec` is linear; the
 *  `[^>]*>` tail is what `replaceListItems` pairs with a pointer instead of a re-scan. */
const LIST_ITEM_OPEN_RE = /<li(?![0-9A-Za-z_])/gi;

/** ASCII-case-insensitive `indexOf`. `needleLower` must already be lowercase ASCII.
 *
 *  Why not `/needle/i`: JS's non-`u` `i` flag folds exactly the ASCII letters and nothing else (the
 *  spec's `Canonicalize` refuses to map a non-ASCII code unit onto an ASCII one, which is why
 *  `/k/i` does NOT match U+212A KELVIN SIGN), so an explicit ASCII fold is the faithful equivalent —
 *  the same discipline the Swift port spells out. Needles here are 3-8 characters, so the naive
 *  scan is linear in `haystack` with a small constant. */
function indexOfAsciiCI(haystack: string, needleLower: string, from: number): number {
  const n = haystack.length;
  const m = needleLower.length;
  outer: for (let i = Math.max(0, from); i + m <= n; i++) {
    for (let k = 0; k < m; k++) {
      let c = haystack.charCodeAt(i + k);
      if (c >= 65 && c <= 90) c += 32; // fold A-Z only
      if (c !== needleLower.charCodeAt(k)) continue outer;
    }
    return i;
  }
  return -1;
}

/** The final tag strip, `html.replace(/<[^>]+>/g, "")`, as a single monotonic forward scan.
 *
 *  Exactly equivalent, and the equivalence is easy to see: the regex's leftmost match at a `<` is
 *  `<`, then the run of characters up to the FIRST `>` after it (that run is non-`>` by
 *  construction), then that `>` — with at least one character in between, since `[^>]+` cannot match
 *  empty. There is nothing for a regex engine to search for that a forward pointer does not already
 *  know, so `gtPtr` never rewinds across the whole scan.
 *
 *  WHY IT IS HAND-WRITTEN. On markup with no `>` after some point — an unterminated tag, i.e. exactly
 *  the malformed shape the rest of this cleaner is hardened against — `<[^>]+>` is O(n²): at EVERY
 *  `<` the engine consumes to end-of-string and then fails. This was the LAST quadratic pass left in
 *  `htmlToText` after the fix-round-2 rewrite above linearized the five paired-tag scans, and it runs
 *  on every byte of every HTML fetch, in chat mode and code mode alike. Measured on this branch,
 *  `"<p>ok</p>" + "<script x".repeat(n)`, a clean 4x per doubling:
 *
 *      opens       bytes     before     after
 *       5,000      45 KB     78 ms      0.2 ms
 *      10,000      90 KB    301 ms      0.3 ms
 *      20,000     180 KB   1457 ms      0.5 ms
 *      40,000     360 KB   6011 ms      0.9 ms
 *
 *  Ported back from the phone's `apple/NormaChatKit/Sources/NormaChatKit/HtmlToText.swift`
 *  (`stripTags`), where the same shape cost 36 s under ICU. Output is byte-identical — the 10,000-doc
 *  ×2 adversarial differential in `html-to-text-differential.test.ts` runs against a frozen oracle
 *  whose final step is literally this regex, and `cleaner-vectors.json` regenerates unchanged.
 *
 *  The single early exit (`no '>' anywhere after here`) is what makes the worst case cheap: if no `>`
 *  remains, no match can start at this position or any later one. */
function stripTags(text: string): string {
  const n = text.length;
  let out = "";
  let copied = 0;
  let i = 0;
  let gtPtr = 0; // monotonic — never rewinds across the whole scan

  while (i < n) {
    if (text.charCodeAt(i) !== LT) { i++; continue; }
    if (gtPtr <= i) gtPtr = i + 1;
    while (gtPtr < n && text.charCodeAt(gtPtr) !== GT) gtPtr++;
    if (gtPtr >= n) break; // no close anywhere after this "<" — nothing more can match
    if (gtPtr > i + 1) { // `[^>]+` needs at least one character, so "<>" is not a tag
      out += text.slice(copied, i);
      copied = gtPtr + 1;
      i = gtPtr + 1;
    } else {
      i++;
    }
  }
  return out + text.slice(copied);
}

/** `html.replace(/<li\b[^>]*>/gi, "\n- ")` as a monotonic forward scan.
 *
 *  SAME BUG, SAME FIX AS `stripTags` — and this pass was measurably WORSE per byte than the strip
 *  (review Critical 1). `[^>]*` followed by a required `>` is O(n²) on the absent-`>` shape: at every
 *  `<li` the engine consumes to end-of-string and then fails. It runs on the full, un-truncated body
 *  of every `text/html` fetch (`web_fetch`, and `fetchCleanPage` for ReadPage / FetchPage / the
 *  research runner), where the only cap in front of it is `MAX_FETCH_BYTES` — 5 MB. Measured on the
 *  real `htmlToText`, `"<li x".repeat(n)`, ×4.3 per doubling:
 *
 *      opens      bytes     before      after
 *       5,000      25 KB      44 ms     0.2 ms
 *      20,000      98 KB     903 ms     0.3 ms
 *      40,000     195 KB    3,254 ms    0.4 ms
 *      80,000     391 KB   13,586 ms    0.7 ms
 *     160,000     781 KB   53,300 ms    1.4 ms   (~39 min extrapolated to the 5 MB cap)
 *
 *  Equivalence: `[^>]*` cannot cross a `>`, so the match at a given `<li` open ends at the FIRST `>`
 *  at or after the open token — there is nothing to search for that a forward pointer does not
 *  already know. `lastIndex` is driven to just past each match, reproducing the global replace's own
 *  jump (so a `<li` nested inside an already-consumed match is not separately matched, exactly as
 *  before), and the early `break` is what makes the worst case cheap: if no `>` follows this open,
 *  none follows any later one either. */
function replaceListItems(html: string): string {
  const n = html.length;
  let out = "";
  let copied = 0;
  let gtPtr = 0; // monotonic — never rewinds across the whole scan
  LIST_ITEM_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIST_ITEM_OPEN_RE.exec(html))) {
    if (m.index < copied) continue; // inside an already-consumed match
    const tokenEnd = LIST_ITEM_OPEN_RE.lastIndex; // just past "<li"
    if (gtPtr < tokenEnd) gtPtr = tokenEnd;
    while (gtPtr < n && html.charCodeAt(gtPtr) !== GT) gtPtr++;
    if (gtPtr >= n) break; // no ">" after this open, nor after any later one
    out += html.slice(copied, m.index) + "\n- ";
    copied = gtPtr + 1;
    LIST_ITEM_OPEN_RE.lastIndex = copied;
  }
  return out + html.slice(copied);
}

export function htmlToText(html: string): string {
  let out = html;
  out = replacePairedTag(out, SCRIPT_OPEN_RE, SCRIPT_CLOSE_RE, () => "");
  out = replacePairedTag(out, STYLE_OPEN_RE, STYLE_CLOSE_RE, () => "");
  out = replacePairedTag(out, HEAD_OPEN_RE, HEAD_CLOSE_RE, () => "");
  // structure worth keeping (user design): headings → #, links → text (url), list items → "- "
  out = convertHeadings(out);
  out = replacePairedTag(out, ANCHOR_OPEN_RE, ANCHOR_CLOSE_RE, (m, inner) => `${inner} (${m[1]})`);
  out = replaceListItems(out); // == .replace(/<li\b[^>]*>/gi, "\n- "), linear — see replaceListItems
  // `<br\s*\/?>` and `</(p|div|h[1-6]|li|tr)>` are both bounded (no `[^>]*`), so neither has the
  // quadratic shape: measured flat at 0.1 ms across the whole doubling series above.
  out = out.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n");
  out = stripTags(out); // == .replace(/<[^>]+>/g, ""), linear — see stripTags
  return out
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

/** `html.match(/<TAG[^>]*>([\s\S]*?)<\/TAG>/i)?.[1]` — the first such element's inner text, or `null`
 *  when the regex would not have matched at all — as a bounded forward scan.
 *
 *  Equivalence, and why only the FIRST `<TAG` occurrence needs looking at (review Critical 1: the
 *  regex is non-global, but a FAILING match still retries at every `<h1` position, which is where the
 *  O(n²) came from). For a candidate open at `i`, `[^>]*` cannot cross a `>`, so the open tag's end
 *  is FORCED to the first `>` at or after `i + 1 + tag.length` — the engine can never backtrack to a
 *  different one. And the first `>` after a LATER candidate is at or after that same position, so if
 *  no `</TAG>` exists after the first candidate's `>`, none exists after any later candidate's
 *  either. The first candidate therefore decides the whole match: no loop, no retry, no re-scan. */
function firstElementInner(html: string, tag: string): string | null {
  const open = indexOfAsciiCI(html, `<${tag}`, 0);
  if (open < 0) return null;
  const openEnd = html.indexOf(">", open + tag.length + 1);
  if (openEnd < 0) return null;
  const close = indexOfAsciiCI(html, `</${tag}>`, openEnd + 1);
  if (close < 0) return null;
  return html.slice(openEnd + 1, close);
}

/** Title extraction happens on the RAW html, before htmlToText runs on the whole page (which
 *  destroys the tags this looks for). Reuses htmlToText only on the small extracted h1/title
 *  snippet — that's just tag-stripping + entity-decoding, not the whole-page conversion.
 *
 *  EXPORTED, and page-core.ts's byte-identical private copy deleted, as part of the Critical-1 fix
 *  (review: "both `extractTitle` regexes … **two copies**"). Two copies of a quadratic meant two
 *  places to fix and two places for the next fix to miss; the duplication was only ever there to
 *  avoid exporting a web.ts internal, and page-core.ts already imports `htmlToText` and
 *  `followRedirects` from here.
 *
 *  `??` and not `||` is deliberate and preserved: an h1 that matched but captured the EMPTY string
 *  short-circuits to `"-"` rather than falling through to `<title>`, because `""` is not nullish. */
export function extractTitle(html: string): string {
  const src = firstElementInner(html, "h1") ?? firstElementInner(html, "title");
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
 *  with a fake (no live network in unit tests); it defaults to the global fetch.
 *
 *  DISCLOSED ASYMMETRY on the raw-authority leg (review Minor 3). Each hop is resolved with
 *  `new URL(loc, current).toString()` below — necessarily, since a `Location` may be relative — which
 *  RE-SERIALIZES it in canonical form. So a `Location: http://0127.0.0.1/` reaches the next
 *  `ssrfGuard` call already rewritten to `http://87.0.0.1/`, and `rawAuthorityHost` has nothing left
 *  to judge: the ambiguous spelling is refused as a model-supplied URL and accepted as a redirect
 *  target. This is not a hole — the dial IS that public canonical address, on the same
 *  WHATWG-canonicalizing `fetch` the guard's canonical leg matches — but it does mean the
 *  defense-in-depth layer stops at hop 0. Closing it properly needs the raw `Location` string carried
 *  alongside the resolved one (only meaningful when `loc` is absolute), which is a shape change to
 *  this loop's contract; deliberately not taken in a fix round whose subject is elsewhere. */
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
    // R-T3: dispatch dropped (was ["code", "dispatch"], R-T2). `deferred: true` below meant this
    // was advertised to dispatch but never callable — dispatch has no ToolSearch of its own to
    // load it with (bug #7's other half; namesForMode only adds ToolSearch for a mode that has
    // something ELSE eligible AND deferred — push_notification still qualifies, so ToolSearch
    // still exists for dispatch, just never alongside a way to load this one). dispatch now uses
    // Search (search.ts) instead — non-deferred, one-call excerpts, no catch-22.
    modes: ["code"],
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
    modes: ["code"], // R-T3: dispatch dropped (was ["code", "dispatch"], R-T2) — see web_fetch's doc comment above
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
          // phone), so the leak matters even more here.
          //
          // Whole-branch re-review FIX (search.ts's identical twin — see its comment for the full
          // reasoning): stderr is NOT operator-only — launchd.ts redirects it to
          // ~/.norma/logs/core.err.log, which the daemon's own read/grep tools can open (only
          // dirs.runDir is denied). Redact the literal key substring before logging; `replaceAll`
          // is sufficient — verified live that Bun embeds the rejected header value byte-for-byte,
          // with no escaping, across every char class that reaches this catch.
          const rawMessage = e instanceof Error ? e.message : String(e);
          const safeMessage = rawMessage.replaceAll(key, "<redacted>");
          console.error(`web_search: network error (${name || "Error"}) — ${safeMessage}`);
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
