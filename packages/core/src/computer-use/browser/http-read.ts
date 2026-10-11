// ComputerV2 Phase 4 — `browsers.read(url)`: a page's text over plain HTTP, with no browser at all. The worker has no
// network (its seatbelt denies it), so this is one more bridge primitive the DAEMON answers, after policy.
//
//   - GET only, no body, no cookies (there is no jar), no Authorization or Referer, nothing the model supplies but the
//     URL; an honest User-Agent (`Mozilla/5.0 (Macintosh; Mac OS X) Winter/<version>`). It is an OBSERVE primitive:
//     allowed under every code and Dispatch policy, `plan` included; no per-app card (no app is involved).
//   - Every hop — the first and each redirect, at most 5 — is checked before anything is sent to it: http(s) only, no
//     user name or password, the DANGEROUS-DOMAIN floor exactly as for tabs (`site-policy.ts`: a site card under
//     ask/accept-edits/plan, a hard block elsewhere and in Dispatch; the time a card waits is not the read's), and the
//     ADDRESS RULE. A hop is LOCAL only when its host is literally this Mac (`localhost`, `*.localhost` — dialled at
//     127.0.0.1 and ::1 without asking DNS —, 127/8, ::1): every address it dials is then loopback. Any other host is a
//     public NAME or address, and every address it resolves to must be public — a name answering loopback or a private
//     address, even beside public ones, is refused, so a dial never falls back across classes. A redirect may lead into
//     this Mac only from a read that started there (a public page must not make the daemon call the user's local
//     services). The connect is pinned to a checked address (`web.ts`'s `followRedirectsWith`), and the LAN is never
//     dialled (no Local Network prompt for Winter). A read never goes through an environment proxy (Bun's fetch obeys
//     `HTTP_PROXY` and friends with no per-request way out, which would bypass the pin): while one applies, it refuses.
//   - 15 s per read (clamped to the script's time left, cancelled with the run, PAUSED while a card waits), at most
//     5 MiB off the wire and 5 MiB once decoded — a compressed body is inflated by hand and stops at the cap (Bun's own
//     inflating is eager and bounds nothing) — HTML converted from at most 1,048,576 characters, at most 1,048,576
//     returned (`truncated` past any cut).
//   - Text only, judged on the response's own type BEFORE its body is read (sniffed only when it names none): HTML/XHTML
//     → readable text (`htmlToText`, numeric references decoded once), plain text, markdown, CSV, JSON, XML and feeds as
//     they are, in the page's own charset (one this runtime cannot decode is an error, never mojibake). Control and
//     bidirectional-override characters are removed.
//   - A status ≥ 400 is a result (an error page can say why), never a throw.
//   - What comes back is PAGE DATA: the run is marked as having read the screen before anything a response could shape
//     is printed or thrown, and it is redacted like `tab.text()` (token-looking runs, credential values in every URL).
//     Sentences the daemon owns never repeat an address a page chose. No cache (a reader often polls); identical reads
//     in flight share one fetch.
//   - At most 8 reads in flight per session and 4 per host (each hop takes its own host's place); further ones wait.
import { lookup } from "node:dns/promises";
import { CORE_VERSION } from "../../version";
import {
  addressClassOf, decodeNumericReferencesInMarkup, extractDocumentTitle, followRedirectsWith, htmlToText, ipAddressClass, type FollowWithOptions,
} from "../../agent/tools/web";
import { AutomationFailure } from "../errors";
import { redactText, redactUrl } from "./page-runtime/redact";
import { ensureSiteAllowed, type SiteApprovals, type SiteFloorDeps } from "./site-policy";
import type { TabRunScope } from "./tab-scope";

export const READ_TIMEOUT_MS = 15_000;
export const READ_MAX_HOPS = 5;
export const READ_MAX_BYTES = 5 * 1024 * 1024;
/** HTML is converted from at most this many characters, and at most this many come back. */
export const READ_MAX_CHARS = 1_048_576;
export const READS_PER_SESSION = 8;
export const READS_PER_HOST = 4;
/** The name a dangerous-domain card gives the reader ("Allow Winter to use <host> in Winter's page reader?"). */
export const READER_NAME = "Winter's page reader";

export const READ_USER_AGENT = `Mozilla/5.0 (Macintosh; Mac OS X) Winter/${CORE_VERSION}`;
const READ_HEADERS: Record<string, string> = {
  Accept: "text/html, text/*, application/json, application/xml;q=0.9, */*;q=0.1",
  "Accept-Encoding": "gzip, deflate, br",
  "User-Agent": READ_USER_AGENT,
};

/** The page redirected somewhere it may not go — said without repeating the page's own choice of address. */
export const REDIRECT_REFUSED = "the page redirected to an address Winter won't read";

export interface ReadResult {
  /** Where the read landed after redirects (credential values redacted). */
  url: string;
  status: number;
  title: string;
  /** The content type without its parameters ("text/html"). */
  type: string;
  text: string;
  truncated: boolean;
  /** The page looks like it renders with JavaScript: open it in a tab for its real content. */
  needsJs: boolean;
}

export interface HttpReaderDeps {
  fetchFn?: FollowWithOptions["fetchFn"];
  /** Every address a name resolves to (both families). Default: the system resolver. */
  resolve?(hostname: string): Promise<readonly string[]>;
  /** The environment a proxy would be read from (default: the daemon's own). */
  env?: Record<string, string | undefined>;
}

/** Where the engine's policy lives, per read. */
export interface ReadPolicy {
  approvals: SiteApprovals;
  site: SiteFloorDeps;
  cwd: string | undefined;
}

const bad = (message: string): Error => Object.assign(new TypeError(message), { name: "TypeError" });

async function systemResolve(hostname: string): Promise<readonly string[]> {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

/** `localhost` and its `.localhost` names: this Mac by definition (RFC 6761), dialled without asking DNS. */
function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

/** The proxy variables Bun's fetch obeys. */
const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;

/**
 * The environment proxy a pinned dial to `address` would go through, by its variable's name — or undefined. Bun's
 * fetch takes no per-request opt-out (measured: `proxy: ""`, `false` and `undefined` all still proxy); only a
 * `NO_PROXY` entry of `*` or of exactly the dialled address is relied on to keep a request direct (both measured),
 * anything less counts as proxied. Nothing here changes the environment.
 */
export function proxyFor(address: string, env: Record<string, string | undefined>): string | undefined {
  const set = PROXY_VARS.find((v) => (env[v] ?? "").trim() !== "");
  if (set === undefined) return undefined;
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const noProxy = `${env.NO_PROXY ?? ""},${env.no_proxy ?? ""}`.split(",").map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
  return noProxy.some((e) => e === "*" || e === bare) ? undefined : set;
}

/** A counting gate: `acquire` waits (cancellable) until a slot is free; the releaser it hands back is idempotent. */
class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  get idle(): boolean { return this.active === 0 && this.waiters.length === 0; }
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const go = (): void => { signal.removeEventListener("abort", stop); resolve(); };
        const stop = (): void => {
          const i = this.waiters.indexOf(go);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new AutomationFailure("Cancelled", "the script ended before this read started"));
        };
        if (signal.aborted) { stop(); return; }
        this.waiters.push(go);
        signal.addEventListener("abort", stop, { once: true });
      });
    }
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const next = this.waiters.shift();
      if (next !== undefined) next();
    };
  }
}

/** The read's own clock: aborts its signal when the budget is spent; paused while a card waits (the script's own
 *  timeout pauses too), resumed clamped to what the script has left. */
class ReadClock {
  private readonly ctl = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private left: number;
  private since = 0;
  constructor(ms: number) { this.left = ms; this.resume(); }
  get signal(): AbortSignal { return this.ctl.signal; }
  get fired(): boolean { return this.ctl.signal.aborted; }
  pause(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.left = Math.max(0, this.left - (Date.now() - this.since));
  }
  resume(cap?: number): void {
    if (this.ctl.signal.aborted || this.timer !== undefined) return;
    if (cap !== undefined) this.left = Math.min(this.left, Math.max(1, cap));
    this.since = Date.now();
    this.timer = setTimeout(() => this.ctl.abort(Object.assign(new Error("the read timed out"), { name: "TimeoutError" })), Math.max(1, this.left));
  }
  stop(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
}

/** The content type's essence ("text/html"), lowercased; "" when absent. */
function essence(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

/** A media type the model may be shown: a strict `type/subtype` token, else nothing (the page chose it). */
function safeType(type: string): string | undefined {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(type) ? type : undefined;
}

function charsetOf(contentType: string): string | undefined {
  const m = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType);
  return m?.[1];
}

/** `<meta charset="…">` or `<meta http-equiv="Content-Type" content="…; charset=…">` in the first 1,024 bytes. */
function metaCharset(head: string): string | undefined {
  return /<meta\b[^>]{0,200}?\bcharset\s*=\s*["']?([A-Za-z0-9._:-]{1,40})/i.exec(head)?.[1];
}

/** The bytes as text in `charset` (UTF-8 when none is named); undefined when this runtime cannot decode it. */
function decode(bytes: Uint8Array, charset: string | undefined): string | undefined {
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset ?? "utf-8"); } catch { return undefined; }
  return decoder.decode(bytes);
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/rss+xml", "application/atom+xml", "application/ld+json",
  "application/javascript", "application/x-javascript", "application/x-ndjson", "application/yaml", "application/x-yaml", "application/toml"]);

/** How a NAMED type is read: as HTML, as text, or not at all. */
function kindOfType(type: string): "html" | "text" | undefined {
  if (HTML_TYPES.has(type)) return "html";
  if (type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml")) return "text";
  return undefined;
}

/** A body that named no type: text unless it holds a NUL in its first 1,024 bytes; HTML when it starts like HTML. */
function sniff(bytes: Uint8Array): "html" | "text" | undefined {
  const head = bytes.subarray(0, 1024);
  if (head.includes(0)) return undefined;
  const lead = new TextDecoder("utf-8").decode(head).trimStart().slice(0, 15).toLowerCase();
  return lead.startsWith("<!doctype html") || lead.startsWith("<html") ? "html" : "text";
}

/** C0 and C1 controls but tab, newline and carriage return, and the bidirectional marks and overrides — removed from
 *  what is returned (a page of controls would otherwise swell several-fold in the bridge's JSON). */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;
export function stripControls(text: string): string {
  return text.replace(CONTROLS, "");
}

/** Every http(s) URL in the text redacted like a tab's (`redactUrl`), then token-looking runs (`redactText`). */
export function redactReadText(text: string): string {
  return redactText(text.replace(/https?:\/\/[^\s()<>"'`]{1,2048}/g, (u) => redactUrl(u)));
}

/** The first `<tag …>` … `</tag>` inner text after `from`, by plain scans (no backtracking); undefined when absent. */
function innerOf(html: string, tag: string, from = 0): { inner: string; end: number } | undefined {
  const lower = html.toLowerCase();
  const open = lower.indexOf(`<${tag}`, from);
  if (open < 0) return undefined;
  const openEnd = lower.indexOf(">", open);
  if (openEnd < 0) return undefined;
  const close = lower.indexOf(`</${tag}>`, openEnd + 1);
  if (close < 0) return undefined;
  return { inner: html.slice(openEnd + 1, close), end: close + tag.length + 3 };
}

const ROOT_IDS = "root|__next|app|__nuxt|svelte";
const EMPTY_ROOT = new RegExp(`<div\\s+id\\s*=\\s*(?:"(?:${ROOT_IDS})"|'(?:${ROOT_IDS})'|(?:${ROOT_IDS})(?=[\\s>]))[^>]{0,200}>\\s{0,200}<\\/div>`, "i");

/**
 * Does an HTML page look like it renders with JavaScript? A hint, never an action. When its readable text is under 200
 * characters: it loads at least one external script, or its content is an empty framework root (`<div id="root"></div>`,
 * `<div id="__next"></div>`, `<app-root></app-root>`, … — the id whole, never a prefix of another). When it is under
 * 2,000: a `<noscript>` asks to enable JavaScript. Plain scans and bounded patterns only: a hostile page cannot make it
 * slow.
 */
export function looksLikeItNeedsJs(html: string, readableText: string): boolean {
  const lower = html.toLowerCase();
  const textLength = readableText.trim().length;
  if (textLength < 200) {
    for (let at = lower.indexOf("<script"), n = 0; at >= 0 && n < 500; at = lower.indexOf("<script", at + 7), n++) {
      const end = lower.indexOf(">", at);
      if (end < 0) break;
      if (/\ssrc\s*=/.test(lower.slice(at, Math.min(end, at + 2_000)))) return true;
    }
    if (EMPTY_ROOT.test(html) || /<app-root\b[^>]{0,200}>\s{0,200}<\/app-root>/i.test(html)) return true;
  }
  if (textLength < 2_000) {
    for (let from = 0, n = 0; n < 20; n++) {
      const block = innerOf(html, "noscript", from);
      if (block === undefined) break;
      if (/(enable|turn on|activate)\s+javascript|javascript\s+(is\s+)?(required|disabled|needed|must be enabled)|requires\s+javascript|needs?\s+javascript/i.test(htmlToText(block.inner.slice(0, 4_000)))) return true;
      from = block.end;
    }
  }
  return false;
}

export class HttpReader {
  private readonly sessions = new Map<string, Gate>();
  private readonly hosts = new Map<string, Gate>();
  private readonly inFlight = new Map<string, Promise<ReadResult>>();

  constructor(private readonly deps: HttpReaderDeps = {}) {}

  /**
   * One `browsers.read`: `url` is already normalised by the engine (`checkTabUrl`). Prints the header and the text
   * (fenced) unless `emit: false`; returns the result either way.
   */
  async read(scope: TabRunScope, url: string, args: Record<string, unknown>, policy: ReadPolicy): Promise<ReadResult> {
    if (url === "about:blank") throw bad("browsers.read() reads an http(s) page — about:blank has nothing to read");
    const facts = scope.sessionFacts();
    if (facts.mode === "chat" || facts.policy === "chat") throw new AutomationFailure("NotAllowed", "computer use is not available in chat");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw bad("browsers.read() takes an http(s) URL"); }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new AutomationFailure("NotAllowed", "browsers.read() never sends a user name or password — a URL with one is refused");
    }
    // Everything after this point may carry what a page sent (its type, its charset, its text): the run has read page
    // data before any of it can be printed or thrown.
    scope.builder.markScreenRead();
    scope.metric.backend = "http";
    scope.noteBrowser("http");
    const key = `${scope.sessionId}\u0000${scope.runId}\u0000${parsed.href}`;
    let shared = this.inFlight.get(key);
    if (shared === undefined) {
      shared = this.fetchOnce(scope, parsed, policy).finally(() => { this.inFlight.delete(key); });
      this.inFlight.set(key, shared);
    }
    const result = await shared;
    scope.live();
    if (args.emit !== false) {
      const lines = [`read ${result.url} — ${this.headerTail(result)}`];
      if (result.text.length > 0) lines.push(result.text);
      scope.builder.text(lines.join("\n"), { screen: true });
    }
    return result;
  }

  private headerTail(r: ReadResult): string {
    const n = r.text.length.toLocaleString("en-US");
    const parts = [`${r.status}${r.status >= 400 ? " (an error page)" : ""} ${safeType(r.type) ?? "(no type)"}`, `${n} character${r.text.length === 1 ? "" : "s"}${r.truncated ? " (cut)" : ""}`];
    if (r.title.length > 0) parts.push(`"${r.title.slice(0, 120)}"`);
    if (r.needsJs) parts.push("looks like it needs JavaScript — open it in a tab for its content");
    return parts.join(" · ");
  }

  private gate(map: Map<string, Gate>, key: string, limit: number): Gate {
    let g = map.get(key);
    if (g === undefined) { g = new Gate(limit); map.set(key, g); }
    return g;
  }

  private forgetIdle(map: Map<string, Gate>, key: string): void {
    if (map.get(key)?.idle === true) map.delete(key);
  }

  private async fetchOnce(scope: TabRunScope, url: URL, policy: ReadPolicy): Promise<ReadResult> {
    const releaseSession = await this.gate(this.sessions, scope.sessionId, READS_PER_SESSION).acquire(scope.signal);
    // Each hop takes its own host's place (released when the read moves to another host, or ends).
    const host: { key?: string; release?: () => void } = {};
    const takeHost = async (hostKey: string): Promise<void> => {
      if (host.key === hostKey) return;
      host.release?.();
      if (host.key !== undefined) this.forgetIdle(this.hosts, host.key);
      host.key = hostKey;
      host.release = undefined;
      host.release = await this.gate(this.hosts, hostKey, READS_PER_HOST).acquire(scope.signal);
    };
    try {
      return await this.fetchAndRead(scope, url, policy, takeHost);
    } finally {
      host.release?.();
      if (host.key !== undefined) this.forgetIdle(this.hosts, host.key);
      releaseSession();
      this.forgetIdle(this.sessions, scope.sessionId);
    }
  }

  private async fetchAndRead(scope: TabRunScope, start: URL, policy: ReadPolicy, takeHost: (hostKey: string) => Promise<void>): Promise<ReadResult> {
    const resolve = this.deps.resolve ?? systemResolve;
    const env = this.deps.env ?? process.env;
    const budgetMs = Math.max(1, Math.min(READ_TIMEOUT_MS, scope.timeLeft()));
    const clock = new ReadClock(budgetMs);
    const signal = AbortSignal.any([scope.signal, clock.signal]);
    const timedOut = (): Error => new Error(`browsers.read() timed out after ${Math.round(budgetMs / 1000)} s reading ${start.host}`);
    let hop = 0;
    // A read that STARTS on this Mac may stay on it; one that starts on a public site may never be redirected INTO it.
    let startedLocal = false;
    const prepare = async (url: URL): Promise<{ addresses: readonly string[] } | { refused: string }> => {
      const first = hop++ === 0;
      scope.noteSite(url.hostname.replace(/^\[|\]$/g, ""));
      // The dangerous-domain floor, exactly as for a tab — its card's wait is not the read's.
      clock.pause();
      try { await ensureSiteAllowed(scope, policy.approvals, policy.site, url.href, READER_NAME, policy.cwd); } finally { clock.resume(scope.timeLeft()); }
      scope.live();
      await takeHost(url.host.toLowerCase());
      scope.live();
      const lexical = addressClassOf(url.href);
      if (lexical?.cls === "private") return { refused: first ? privateSentence(url.hostname) : REDIRECT_REFUSED };
      const local = lexical?.cls === "loopback";
      if (!first && local && !startedLocal) return { refused: REDIRECT_REFUSED };
      const name = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: readonly string[];
      if (isLocalhostName(name)) addresses = ["127.0.0.1", "::1"];
      else {
        try {
          addresses = await raceSignal(resolve(name), signal);
        } catch (e) {
          if (signal.aborted) throw e;
          throw new Error(`browsers.read(): ${first ? url.hostname : "the address the page redirected to"} could not be resolved`);
        }
      }
      for (const a of addresses) {
        const cls = ipAddressClass(a);
        if (local ? cls !== "loopback" : cls !== null) {
          if (!first) return { refused: REDIRECT_REFUSED };
          return { refused: local
            ? `${url.hostname} resolved to an address outside this Mac — browsers.read() reads only this Mac's own servers by that name`
            : `${url.hostname} resolves to this Mac or the local network — browsers.read() reads public sites by name, and this Mac's own servers only as localhost` };
        }
        const proxy = proxyFor(a, env);
        if (proxy !== undefined) {
          return { refused: `a network proxy is set for Winter (${proxy}), and browsers.read() never reads through one — open the page in a tab, or remove the proxy setting from Winter's environment` };
        }
      }
      if (first) startedLocal = local;
      return { addresses };
    };
    let res: Awaited<ReturnType<typeof followRedirectsWith>>;
    try {
      res = await followRedirectsWith(start.href, {
        prepare, fetchFn: this.deps.fetchFn, signal, maxHops: READ_MAX_HOPS, maxBytes: READ_MAX_BYTES, maxDecodedBytes: READ_MAX_BYTES, headers: READ_HEADERS,
        acceptType: (ct) => { const t = essence(ct); return t === "" || kindOfType(t) !== undefined; },
      });
    } catch (err) {
      if (scope.signal.aborted) throw new AutomationFailure("Cancelled", "the script was cancelled during a read");
      if (clock.fired) throw timedOut();
      throw err;
    } finally {
      clock.stop();
    }
    if (!res.ok) {
      if (scope.signal.aborted) throw new AutomationFailure("Cancelled", "the script was cancelled during a read");
      switch (res.kind) {
        case "refused": throw new AutomationFailure("NotAllowed", res.error);
        case "invalid": throw new AutomationFailure("NotAllowed", REDIRECT_REFUSED);
        case "timeout": throw timedOut();
        case "type": throw notText(res.contentType ?? "");
        default: throw new Error(`browsers.read(): ${res.error}`);
      }
    }
    scope.live();
    scope.metric.httpStatus = res.status;
    scope.metric.bytes = res.bytesRead;
    const type = essence(res.contentType);
    const kind = type === "" ? sniff(res.body) : kindOfType(type);
    if (kind === undefined) throw notText(res.contentType);
    let charset = charsetOf(res.contentType);
    if (charset === undefined && kind === "html") charset = metaCharset(new TextDecoder("latin1").decode(res.body.subarray(0, 1024)));
    const decoded = decode(res.body, charset);
    if (decoded === undefined) {
      const named = charset !== undefined && /^[A-Za-z0-9._:-]{1,40}$/.test(charset) ? ` (${charset})` : "";
      throw new Error(`the page is in a character set browsers.read() can't decode${named} — open it in a tab`);
    }
    let truncated = res.truncated;
    let text: string;
    let title = "";
    let needsJs = false;
    if (kind === "html") {
      let html = decoded;
      if (html.length > READ_MAX_CHARS) { html = html.slice(0, READ_MAX_CHARS); truncated = true; }
      text = htmlToText(decodeNumericReferencesInMarkup(html));
      title = extractDocumentTitle(html);
      needsJs = looksLikeItNeedsJs(html, text);
    } else {
      text = decoded;
    }
    text = stripControls(text);
    if (text.length > READ_MAX_CHARS) { text = text.slice(0, READ_MAX_CHARS); truncated = true; }
    return {
      url: redactUrl(res.url), status: res.status, title: redactReadText(stripControls(title).replace(/\s+/g, " ").trim()), type,
      text: redactReadText(text), truncated, needsJs,
    };
  }
}

function notText(contentType: string): Error {
  return new Error(`${safeType(essence(contentType)) ?? "that content"} is not text — open it with apps.open(url) or in a tab`);
}

/** The refusal for the FIRST hop's own private host (the model's own input, so it may be named). */
function privateSentence(host: string): string {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "0.0.0.0" || h === "::") return `${h} is not a server's address — for a server on this Mac, read http://localhost:<port>/`;
  return `${host} is a private network address — browsers.read() reads public sites and this Mac's own (localhost), never the local network`;
}

/** `p`, or a rejection as soon as `signal` aborts (a DNS lookup takes no signal). */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}
