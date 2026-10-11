// ComputerV2 Phase 4 — `browsers.read(url)`: a page's text over plain HTTP, with no browser at all. The worker has no
// network (its seatbelt denies it), so this is one more bridge primitive the DAEMON answers, after policy.
//
//   - GET only, no body, no cookies (there is no jar), no Authorization or Referer, nothing the model supplies but the
//     URL; an honest User-Agent (`Mozilla/5.0 (Macintosh; Mac OS X) Winter/<version>`). It is an OBSERVE primitive:
//     allowed under every code and Dispatch policy, `plan` included; no per-app card (no app is involved).
//   - Every hop — the first and each redirect, at most 5 — is checked before anything is sent to it: http(s) only, no
//     user name or password, the DANGEROUS-DOMAIN floor exactly as for tabs (`site-policy.ts`: a site card under
//     ask/accept-edits/plan, a hard block elsewhere and in Dispatch), and the ADDRESS RULE: this Mac's loopback is
//     allowed (a local dev server), every other private address refused — on the host as written and as
//     canonicalised, and again on EVERY address its name resolves to. The connect is pinned to a checked address
//     (`web.ts`'s `followRedirectsWith`), so a second DNS answer cannot move it into the LAN, and the LAN is never
//     dialled (no Local Network prompt for Winter).
//   - 15 s per read (clamped to the script's time left, cancelled with the run), at most 5 MiB off the wire, HTML
//     converted from at most 1,048,576 characters, at most 1,048,576 characters returned (`truncated` past any cut).
//   - Text only: HTML/XHTML → readable text (`htmlToText`, numeric references decoded); plain text, markdown, CSV,
//     JSON, XML and feeds as they are, in the page's own charset. Anything else is an `Error`.
//   - A status ≥ 400 is a result (an error page can say why), never a throw.
//   - What comes back is PAGE DATA: fenced like every other read, and redacted like `tab.text()` (token-looking runs,
//     credential values in URLs). No cache (a reader often polls); identical reads in flight share one fetch.
//   - At most 8 reads in flight per session and 4 per host; further ones wait in the daemon.
import { lookup } from "node:dns/promises";
import { CORE_VERSION } from "../../version";
import { addressClassOf, decodeNumericEntities, extractTitle, followRedirectsWith, htmlToText, ipAddressClass, type FollowWithOptions } from "../../agent/tools/web";
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
  "Accept-Encoding": "gzip, br",
  "User-Agent": READ_USER_AGENT,
};

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

/** A counting gate: `acquire` waits (cancellable) until a slot is free. */
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
    } else {
      this.active++;
      return this.releaser();
    }
    this.active++;
    return this.releaser();
  }
  private releaser(): () => void {
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

/** The content type's essence ("text/html"), lowercased; "" when absent. */
function essence(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function charsetOf(contentType: string): string | undefined {
  const m = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType);
  return m?.[1];
}

/** `<meta charset="…">` or `<meta http-equiv="Content-Type" content="…; charset=…">` in the first 1,024 bytes. */
function metaCharset(head: string): string | undefined {
  return /<meta\b[^>]{0,200}?\bcharset\s*=\s*["']?([A-Za-z0-9._:-]{1,40})/i.exec(head)?.[1];
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  if (charset !== undefined) {
    try { return new TextDecoder(charset).decode(bytes); } catch { /* an unknown label: UTF-8 */ }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/rss+xml", "application/atom+xml", "application/ld+json",
  "application/javascript", "application/x-javascript", "application/x-ndjson", "application/yaml", "application/x-yaml", "application/toml"]);

/** How a body is read: as HTML, as text, or not at all. A missing type is judged by the bytes. */
function kindOf(type: string, bytes: Uint8Array): "html" | "text" | undefined {
  if (HTML_TYPES.has(type)) return "html";
  if (type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml")) return "text";
  if (type === "" || type === "application/octet-stream") {
    const head = bytes.subarray(0, 1024);
    if (head.includes(0)) return undefined;
    const lead = new TextDecoder("utf-8").decode(head).trimStart().slice(0, 15).toLowerCase();
    return lead.startsWith("<!doctype html") || lead.startsWith("<html") ? "html" : type === "" ? "text" : undefined;
  }
  return undefined;
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

/**
 * Does an HTML page look like it renders with JavaScript? A hint, never an action. When its readable text is under 200
 * characters: it loads at least one external script, or its content is an empty framework root (`<div id="root"></div>`,
 * `<div id="__next"></div>`, `<app-root></app-root>`, …). When it is under 2,000: a `<noscript>` asks to enable
 * JavaScript. Plain scans and bounded patterns only: a hostile page cannot make it slow.
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
    if (/<div\s+id\s*=\s*["']?(?:root|__next|app|__nuxt|svelte)["']?[^>]{0,200}>\s{0,200}<\/div>/i.test(html) || /<app-root\b[^>]{0,200}>\s{0,200}<\/app-root>/i.test(html)) return true;
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
    scope.builder.markScreenRead();
    if (args.emit !== false) {
      const lines = [`read ${result.url} — ${this.headerTail(result)}`];
      if (result.text.length > 0) lines.push(result.text);
      scope.builder.text(lines.join("\n"), { screen: true });
    }
    return result;
  }

  private headerTail(r: ReadResult): string {
    const n = r.text.length.toLocaleString("en-US");
    const parts = [`${r.status}${r.status >= 400 ? " (an error page)" : ""} ${r.type || "(no type)"}`, `${n} character${r.text.length === 1 ? "" : "s"}${r.truncated ? " (cut)" : ""}`];
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
    const sessionGate = this.gate(this.sessions, scope.sessionId, READS_PER_SESSION);
    const releaseSession = await sessionGate.acquire(scope.signal);
    const hostKey = url.host.toLowerCase();
    let releaseHost: (() => void) | undefined;
    try {
      releaseHost = await this.gate(this.hosts, hostKey, READS_PER_HOST).acquire(scope.signal);
      scope.live();
      return await this.fetchAndRead(scope, url, policy);
    } finally {
      releaseHost?.();
      releaseSession();
      this.forgetIdle(this.hosts, hostKey);
      this.forgetIdle(this.sessions, scope.sessionId);
    }
  }

  private async fetchAndRead(scope: TabRunScope, start: URL, policy: ReadPolicy): Promise<ReadResult> {
    const resolve = this.deps.resolve ?? systemResolve;
    const timeoutMs = Math.max(1, Math.min(READ_TIMEOUT_MS, scope.timeLeft()));
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([scope.signal, timeout]);
    let hop = 0;
    const prepare = async (url: URL): Promise<{ addresses: readonly string[] } | { refused: string }> => {
      const first = hop++ === 0;
      // The dangerous-domain floor, exactly as for a tab: a card under the policies that ask, else a hard block.
      await ensureSiteAllowed(scope, policy.approvals, policy.site, url.href, READER_NAME, policy.cwd);
      scope.live();
      const lexical = addressClassOf(url.href);
      if (lexical?.cls === "private") return { refused: privateSentence(url.hostname, first) };
      const name = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: readonly string[];
      try {
        addresses = await raceSignal(resolve(name), signal);
      } catch (e) {
        if (signal.aborted) throw e;
        throw new Error(`browsers.read(): ${url.hostname} could not be resolved — check the address`);
      }
      for (const a of addresses) {
        if (ipAddressClass(a) === "private") return { refused: privateSentence(url.hostname, first) };
      }
      return { addresses };
    };
    let res: Awaited<ReturnType<typeof followRedirectsWith>>;
    try {
      res = await followRedirectsWith(start.href, { prepare, fetchFn: this.deps.fetchFn, signal, maxHops: READ_MAX_HOPS, maxBytes: READ_MAX_BYTES, headers: READ_HEADERS });
    } catch (err) {
      if (scope.signal.aborted) throw new AutomationFailure("Cancelled", "the script was cancelled during a read");
      if (timeout.aborted) throw new Error(`browsers.read() timed out after ${Math.round(timeoutMs / 1000)} s reading ${start.host}`);
      throw err;
    }
    if (!res.ok) {
      if (scope.signal.aborted) throw new AutomationFailure("Cancelled", "the script was cancelled during a read");
      switch (res.kind) {
        case "refused": throw new AutomationFailure("NotAllowed", res.error);
        case "timeout": throw new Error(`browsers.read() timed out after ${Math.round(timeoutMs / 1000)} s reading ${start.host}`);
        case "redirects": throw new Error(`browsers.read(): ${res.error}`);
        default: throw new Error(`browsers.read(): ${res.error}`);
      }
    }
    scope.live();
    const final = new URL(res.url);
    scope.noteSite(final.hostname);
    scope.metric.httpStatus = res.status;
    scope.metric.bytes = res.bytesRead;
    const type = essence(res.contentType);
    const kind = kindOf(type, res.body);
    if (kind === undefined) {
      throw new Error(`${type || "that content"} is not text — open it with apps.open(url) or in a tab`);
    }
    let charset = charsetOf(res.contentType);
    if (charset === undefined && kind === "html") charset = metaCharset(new TextDecoder("latin1").decode(res.body.subarray(0, 1024)));
    const decoded = decode(res.body, charset);
    let truncated = res.truncated;
    let text: string;
    let title = "";
    let needsJs = false;
    if (kind === "html") {
      let html = decoded;
      if (html.length > READ_MAX_CHARS) { html = html.slice(0, READ_MAX_CHARS); truncated = true; }
      text = decodeNumericEntities(htmlToText(html));
      const t = extractTitle(html);
      title = t === "-" ? "" : decodeNumericEntities(t);
      needsJs = looksLikeItNeedsJs(html, text);
    } else {
      text = decoded;
    }
    if (text.length > READ_MAX_CHARS) { text = text.slice(0, READ_MAX_CHARS); truncated = true; }
    return {
      url: redactUrl(res.url), status: res.status, title: redactText(title.replace(/\s+/g, " ").trim()), type,
      text: redactText(text), truncated, needsJs,
    };
  }
}

function privateSentence(host: string, first: boolean): string {
  return first
    ? `${host} is a private network address — browsers.read() reads public sites and this Mac's own (localhost), never the local network`
    : `a redirect led to a private network address (${host}) — browsers.read() never reads the local network`;
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
