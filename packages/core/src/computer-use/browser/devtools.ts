// ComputerV2 Phase 3 — a tab's DEVELOPER READERS: its console (`console()`) and its network log (`network()`,
// `networkBody(id)`), kept per tab by its driver from the events the transport lets through — already reduced by
// `cdp-reduce.ts` (no header, cookie, post data or page object ever reaches here). What Winter saw while it worked in
// the tab: nothing arrives while the tab is released (a user's tab, a built-in tab's hold, at turn end). Every text the
// model reads is redacted here (token-looking runs, credentials in URLs) and printed fenced by the engine.
import { redactText, redactUrl } from "./page-runtime/redact";

export const CONSOLE_KEPT = 1_000;
export const NETWORK_KEPT = 1_000;
export const CONSOLE_TEXT_MAX = 2_000;
export const NETWORK_URL_MAX = 2_048;
export const READ_LIMIT_DEFAULT = 100;
export const READ_LIMIT_MAX = 1_000;

export const CONSOLE_LEVELS = ["error", "warning", "info", "log", "debug"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** One console entry as the model reads it. */
export interface LogEntry { level: ConsoleLevel | "page"; text: string; at: string; source?: string }
/** One request as the model reads it. */
export interface RequestEntry { id: string; method: string; url: string; type: string; status?: number; mime?: string; ms?: number; bytes?: number; failed?: string }

interface LogRec { level: ConsoleLevel | "page"; text: string; atMs: number; source?: string; key: string }
interface ReqRec extends RequestEntry {
  /** The CDP session and the browser's request id — what `Network.getResponseBody` takes. */
  session?: string;
  requestId: string;
  startTs?: number;
  wallMs?: number;
  fromCache?: boolean;
  redirected?: boolean;
  done: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

function levelOfConsole(type: string): ConsoleLevel {
  switch (type) {
    case "error": case "assert": return "error";
    case "warning": case "warn": return "warning";
    case "info": case "count": case "timeEnd": return "info";
    case "debug": return "debug";
    default: return "log";
  }
}

function levelOfLog(level: string): ConsoleLevel {
  switch (level) {
    case "error": return "error";
    case "warning": return "warning";
    case "verbose": return "debug";
    default: return "info";
  }
}

/** One console argument as the console shows it: a primitive by its value, anything else by its description. */
function argText(a: unknown): string {
  if (!isRecord(a)) return "";
  if (a.type === "string" && typeof a.value === "string") return a.value;
  if (a.type === "undefined") return "undefined";
  if (a.value === null && a.subtype === "null") return "null";
  if (typeof a.value === "number" || typeof a.value === "boolean") return String(a.value);
  if (typeof a.unserializableValue === "string") return a.unserializableValue;
  if (typeof a.description === "string") return a.description;
  if (typeof a.className === "string") return a.className;
  return typeof a.type === "string" ? a.type : "";
}

/** A console call's text: `%s %d %i %f %o %O` take the next argument, `%c` (a style) takes one and shows nothing. */
export function renderConsoleArgs(args: readonly unknown[]): string {
  if (args.length === 0) return "";
  const first = args[0];
  const rest = args.slice(1);
  let head = argText(first);
  if (isRecord(first) && first.type === "string" && /%[sdifoOc%]/.test(head)) {
    head = head.replace(/%([sdifoOc%])/g, (m, k: string) => {
      if (k === "%") return "%";
      if (rest.length === 0) return m;
      const a = rest.shift();
      if (k === "c") return "";
      const t = argText(a);
      if (k === "d" || k === "i") { const n = Number(t); return Number.isFinite(n) ? String(Math.trunc(n)) : "NaN"; }
      if (k === "f") { const n = Number(t); return Number.isFinite(n) ? String(n) : "NaN"; }
      return t;
    });
  }
  return [head, ...rest.map(argText)].join(" ");
}

function sourceOf(url: unknown, line: unknown, col: unknown): string | undefined {
  const u = str(url);
  if (u === undefined || u.length === 0) return undefined;
  const l = num(line);
  const c = num(col);
  // CDP's lines and columns count from 0; a person's from 1.
  return `${redactUrl(cut(u, NETWORK_URL_MAX))}${l === undefined ? "" : `:${l + 1}`}${l === undefined || c === undefined ? "" : `:${c + 1}`}`;
}

export class TabDevtools {
  private logs: LogRec[] = [];
  /** Keys of console entries already kept — a re-attach replays the document's earlier messages (`Runtime.enable`). */
  private readonly logKeys = new Set<string>();
  private reqs: ReqRec[] = [];
  private readonly reqByKey = new Map<string, ReqRec>();
  private nextReq = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Feed one (reduced) event. `isWinterContext` drops anything the engine's own world logged. */
  onEvent(method: string, params: Record<string, unknown>, session: string | undefined, isWinterContext: (id: number) => boolean): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const ctx = num(params.executionContextId);
        if (ctx !== undefined && isWinterContext(ctx)) return;
        const type = str(params.type) ?? "log";
        if (type === "endGroup" || type === "clear") return;
        const frames = isRecord(params.stackTrace) && Array.isArray(params.stackTrace.callFrames) ? params.stackTrace.callFrames : [];
        const top = isRecord(frames[0]) ? frames[0] : {};
        this.addLog(levelOfConsole(type), renderConsoleArgs(Array.isArray(params.args) ? params.args : []), num(params.timestamp), sourceOf(top.url, top.lineNumber, top.columnNumber), `c|${String(params.timestamp)}|${type}`);
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
        const ctx = num(d.executionContextId);
        if (ctx !== undefined && isWinterContext(ctx)) return;
        const ex = isRecord(d.exception) ? d.exception : {};
        const text = str(ex.description) ?? str(d.text) ?? "Uncaught exception";
        const lead = str(d.text);
        this.addLog("error", lead !== undefined && lead !== text && !text.startsWith(lead) ? `${lead} ${text}` : text, num(params.timestamp), sourceOf(d.url, d.lineNumber, d.columnNumber), `x|${String(params.timestamp)}`);
        break;
      }
      case "Log.entryAdded": {
        const e = isRecord(params.entry) ? params.entry : {};
        const src = str(e.source);
        const where = sourceOf(e.url, e.lineNumber, undefined);
        this.addLog(levelOfLog(str(e.level) ?? "info"), `${src === undefined || src === "javascript" || src === "console-api" ? "" : `[${src}] `}${str(e.text) ?? ""}`, num(e.timestamp), where, `l|${String(e.timestamp)}|${str(e.networkRequestId) ?? ""}`);
        break;
      }
      case "Network.requestWillBeSent": {
        const requestId = str(params.requestId);
        if (requestId === undefined) return;
        const key = `${session ?? ""}:${requestId}`;
        const req = isRecord(params.request) ? params.request : {};
        const prev = this.reqByKey.get(key);
        const redirect = isRecord(params.redirectResponse) ? params.redirectResponse : undefined;
        if (prev !== undefined && redirect !== undefined) {
          // A redirect: the previous hop ends with its 3xx status; the next starts a new entry for the same request.
          const status = num(redirect.status);
          if (status !== undefined) prev.status = status;
          prev.redirected = true;
          prev.done = true;
          const ts = num(params.timestamp);
          if (ts !== undefined && prev.startTs !== undefined) prev.ms = Math.max(0, Math.round((ts - prev.startTs) * 1000));
        }
        const wall = num(params.wallTime);
        const rec: ReqRec = {
          id: `r${this.nextReq++}`, method: str(req.method) ?? "GET", url: redactUrl(cut(str(req.url) ?? "", NETWORK_URL_MAX)),
          type: (str(params.type) ?? "other").toLowerCase(), requestId, done: false,
          ...(session === undefined ? {} : { session }),
          ...(num(params.timestamp) === undefined ? {} : { startTs: num(params.timestamp)! }),
          ...(wall === undefined ? {} : { wallMs: Math.round(wall * 1000) }),
        };
        this.reqByKey.set(key, rec);
        this.reqs.push(rec);
        this.trimRequests();
        break;
      }
      case "Network.responseReceived": {
        const rec = this.reqByKey.get(`${session ?? ""}:${str(params.requestId) ?? ""}`);
        if (rec === undefined) return;
        const r = isRecord(params.response) ? params.response : {};
        const status = num(r.status);
        if (status !== undefined) rec.status = status;
        const mime = str(r.mimeType);
        if (mime !== undefined && mime.length > 0) rec.mime = mime;
        if (r.fromDiskCache === true || r.fromServiceWorker === true) rec.fromCache = true;
        const type = str(params.type);
        if (type !== undefined) rec.type = type.toLowerCase();
        break;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const rec = this.reqByKey.get(`${session ?? ""}:${str(params.requestId) ?? ""}`);
        if (rec === undefined) return;
        rec.done = true;
        const ts = num(params.timestamp);
        if (ts !== undefined && rec.startTs !== undefined) rec.ms = Math.max(0, Math.round((ts - rec.startTs) * 1000));
        const bytes = num(params.encodedDataLength);
        if (bytes !== undefined) rec.bytes = bytes;
        if (method === "Network.loadingFailed") rec.failed = params.canceled === true ? "canceled" : (str(params.errorText) ?? "failed") + (typeof params.blockedReason === "string" ? ` (blocked: ${params.blockedReason})` : "");
        break;
      }
      default:
        break;
    }
  }

  /** A new top-frame document: said in the console log, so its messages read in order. */
  newPage(url: string): void {
    if (this.logs.length === 0) return;
    this.addLog("page", `— new page: ${redactUrl(cut(url, 200))} —`, this.now(), undefined, `p|${this.now()}|${url}`);
  }

  private addLog(level: ConsoleLevel | "page", text: string, atMs: number | undefined, source: string | undefined, keyBase: string): void {
    const key = `${keyBase}|${text.slice(0, 200)}`;
    if (this.logKeys.has(key)) return;
    this.logKeys.add(key);
    this.logs.push({ level, text: redactText(cut(text, CONSOLE_TEXT_MAX)), atMs: atMs ?? this.now(), key, ...(source === undefined ? {} : { source }) });
    while (this.logs.length > CONSOLE_KEPT) this.logKeys.delete(this.logs.shift()!.key);
  }

  private trimRequests(): void {
    while (this.reqs.length > NETWORK_KEPT) {
      const old = this.reqs.shift()!;
      const key = `${old.session ?? ""}:${old.requestId}`;
      if (this.reqByKey.get(key) === old) this.reqByKey.delete(key);
    }
  }

  /** The console, newest last. */
  console(o: { levels?: readonly string[]; filter?: string; limit?: number } = {}): { entries: LogEntry[]; counts: Record<string, number>; total: number } {
    const levels = o.levels !== undefined && o.levels.length > 0 ? new Set(o.levels.map((l) => (l === "warn" ? "warning" : l))) : undefined;
    const needle = o.filter?.toLowerCase();
    const counts: Record<string, number> = {};
    for (const l of this.logs) if (l.level !== "page") counts[l.level] = (counts[l.level] ?? 0) + 1;
    const matching = this.logs.filter((l) => (l.level === "page" ? levels === undefined && needle === undefined : (levels === undefined || levels.has(l.level)) && (needle === undefined || l.text.toLowerCase().includes(needle) || (l.source ?? "").toLowerCase().includes(needle))));
    const limit = clampLimit(o.limit);
    const entries = matching.slice(-limit).map((l) => ({ level: l.level, text: l.text, at: new Date(l.atMs).toISOString(), ...(l.source === undefined ? {} : { source: l.source }) }));
    return { entries, counts, total: matching.length };
  }

  clearConsole(): void { this.logs = []; this.logKeys.clear(); }

  /** The network log, newest last. */
  network(o: { filter?: string; types?: readonly string[]; failed?: boolean; limit?: number } = {}): { entries: RequestEntry[]; total: number } {
    const needle = o.filter?.toLowerCase();
    const types = o.types !== undefined && o.types.length > 0 ? new Set(o.types.map((t) => t.toLowerCase())) : undefined;
    const matching = this.reqs.filter((r) => (needle === undefined || r.url.toLowerCase().includes(needle))
      && (types === undefined || types.has(r.type))
      && (o.failed !== true || r.failed !== undefined || (r.status !== undefined && r.status >= 400)));
    const limit = clampLimit(o.limit);
    return { entries: matching.slice(-limit).map(publicEntry), total: matching.length };
  }

  clearNetwork(): void { this.reqs = []; this.reqByKey.clear(); }

  /** A request by its model id: where its body lives. */
  request(id: string): (RequestEntry & { session?: string; requestId: string; done: boolean }) | undefined {
    const r = this.reqs.find((x) => x.id === id);
    return r === undefined ? undefined : { ...publicEntry(r), requestId: r.requestId, done: r.done, ...(r.session === undefined ? {} : { session: r.session }) };
  }

  /** Every request URL of these resource types seen (for `assets()`). */
  urlsOfTypes(types: ReadonlySet<string>): Array<{ type: string; url: string }> {
    return this.reqs.filter((r) => types.has(r.type)).map((r) => ({ type: r.type, url: r.url }));
  }
}

function publicEntry(r: ReqRec): RequestEntry {
  return {
    id: r.id, method: r.method, url: r.url, type: r.type,
    ...(r.status === undefined ? {} : { status: r.status }), ...(r.mime === undefined ? {} : { mime: r.mime }),
    ...(r.ms === undefined ? {} : { ms: r.ms }), ...(r.bytes === undefined ? {} : { bytes: r.bytes }),
    ...(r.failed === undefined ? {} : { failed: r.failed }),
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return READ_LIMIT_DEFAULT;
  return Math.min(READ_LIMIT_MAX, Math.floor(limit));
}

/** "1.2 KB" */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A console entry's printed line: `[error] 12:03:04.120 text — source`. */
export function consoleLine(e: LogEntry): string {
  if (e.level === "page") return e.text;
  const t = new Date(e.at);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  const ms = String(t.getMilliseconds()).padStart(3, "0");
  return `[${e.level}] ${hh}:${mm}:${ss}.${ms} ${e.text}${e.source === undefined ? "" : ` — ${e.source}`}`;
}

/** A request's printed line: `r12 GET 200 xhr 34 ms 1.2 KB https://…`. */
export function requestLine(r: RequestEntry): string {
  const status = r.failed !== undefined ? `failed (${r.failed})` : r.status === undefined ? "pending" : String(r.status);
  const parts = [r.id, r.method, status, r.type];
  if (r.ms !== undefined) parts.push(`${r.ms} ms`);
  if (r.bytes !== undefined) parts.push(bytesLabel(r.bytes));
  parts.push(r.url.length > 200 ? `${r.url.slice(0, 200)}…` : r.url);
  return parts.join(" ");
}
