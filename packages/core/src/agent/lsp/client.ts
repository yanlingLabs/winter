import { spawn, type ChildProcess } from "node:child_process";

// Minimal LSP stdio client: JSON-RPC over child-process stdio, Content-Length framed (LSP's
// wire format is byte-counted, NOT line-delimited — unlike this repo's `mcp/client.ts`, whose
// buffering/pending-map/dead-state architecture this file otherwise mirrors). Diagnostics are
// server-PUSH (`textDocument/publishDiagnostics`, no id); definitions/references are ordinary
// id-correlated requests. Every await here is bounded by a typed-error timeout; a mid-session
// child exit or process error rejects every pending request/diagnostics waiter — callers never
// hang a turn on a wedged or crashed language server.

export interface LspLocation { path: string; line: number; character: number } // 0-based, as LSP returns
export interface LspDiagnostic { line: number; character: number; severity: 1 | 2 | 3 | 4; message: string; source?: string } // 0-based

// A junk env value must fall back to the default, not become NaN — setTimeout(fn, NaN) fires
// immediately, which would silently zero every bound below.
function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_START_TIMEOUT_MS = envNum("WINTER_LSP_START_TIMEOUT_MS", 10000);
const DEFAULT_REQUEST_TIMEOUT_MS = envNum("WINTER_LSP_REQUEST_TIMEOUT_MS", 10000);
const DEFAULT_DIAG_TIMEOUT_MS = envNum("WINTER_LSP_DIAG_TIMEOUT_MS", 5000);
// Diagnostics settle window: real servers publish MORE THAN ONCE per didOpen (tsserver runs a fast
// syntactic pass first and the semantic pass later, as separate publishes — the first is often
// empty even when the file has a type error). diagnostics() therefore resolves with the LATEST
// publish once no further publish has arrived for this long — never with the first one blindly.
const DEFAULT_DIAG_SETTLE_MS = envNum("WINTER_LSP_DIAG_SETTLE_MS", 400);
const STOP_TIMEOUT_MS = envNum("WINTER_LSP_STOP_TIMEOUT_MS", 5000);
const STDERR_TAIL_MAX = 2000; // cap so a chatty server can't grow this unbounded across a long session

/** A request/diagnostics-wait didn't settle within its bound. Distinguishes "still waiting" from
 *  every other rejection so callers can retry/report a hang specifically. */
export class LspTimeoutError extends Error { constructor(message: string) { super(message); this.name = "LspTimeoutError"; } }
/** The server process exited (or errored on spawn) while requests/waiters were pending. */
export class LspServerExitedError extends Error { constructor(message: string) { super(message); this.name = "LspServerExitedError"; } }
/** `start()`/`diagnostics()`/`definition()`/`references()` called after `stop()` or a death. */
export class LspNotRunningError extends Error { constructor(message = "lsp server is not running") { super(message); this.name = "LspNotRunningError"; } }
/** The server answered a request with a JSON-RPC `error` object. */
export class LspRequestError extends Error { constructor(message: string, public readonly code?: number) { super(message); this.name = "LspRequestError"; } }
/** The server does not implement the requested capability — JSON-RPC code -32601 ("method not
 *  found"), the standard signal a conforming LSP server sends for an OPTIONAL method it never
 *  registered (hover/documentSymbol/workspace-symbol/implementation are all optional per the LSP
 *  spec, unlike definition/references/diagnostics, which every server this repo targets
 *  implements — see `requestCapable` below, the ONLY place this is thrown). Callers (tools/lsp.ts)
 *  render this as a clean "not supported" result, never a crash. */
export class LspNotSupportedError extends Error { constructor(message: string) { super(message); this.name = "LspNotSupportedError"; } }

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function languageIdForUri(uri: string): string {
  const ext = /\.([a-zA-Z0-9]+)$/.exec(uri)?.[1]?.toLowerCase();
  switch (ext) {
    case "ts": case "mts": case "cts": return "typescript";
    case "tsx": return "typescriptreact";
    case "js": case "mjs": case "cjs": return "javascript";
    case "jsx": return "javascriptreact";
    case "swift": return "swift";
    default: return "plaintext";
  }
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri; // defensive: pass through non-file URIs unchanged
  let p = decodeURIComponent(uri.slice("file://".length));
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1); // file:///C:/foo → C:/foo
  return p;
}

// LSP's textDocument/definition (etc.) result is Location | Location[] | LocationLink[] | null;
// LocationLink uses targetUri/targetSelectionRange instead of uri/range.
function toLocations(res: unknown): LspLocation[] {
  if (res == null) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr.map((loc: any) => {
    const uri = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
    return { path: uriToPath(uri), line: range?.start?.line ?? 0, character: range?.start?.character ?? 0 };
  });
}

function toDiagnostics(raw: unknown): LspDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d: any) => ({
    line: d.range?.start?.line ?? 0,
    character: d.range?.start?.character ?? 0,
    severity: (d.severity ?? 1) as 1 | 2 | 3 | 4,
    message: String(d.message ?? ""),
    ...(d.source ? { source: String(d.source) } : {}),
  }));
}

// -------------------------------------------------------------------------------------------
// lsp consolidation T1: hover/documentSymbols/workspaceSymbols render straight to a MODEL-FACING
// string (unlike definition/references/diagnostics/implementation, which return raw 0-based
// structured data — LspLocation[]/LspDiagnostic[] — for tools/lsp.ts to format with fence-checked
// disk previews and caps). That split is deliberate: hover/symbols content has no further
// arithmetic done on it by any caller, so there's no "0-based throughout" contract to uphold for
// it the way there is for locations a caller adds 1 to before display — the line/character numbers
// baked into these rendered strings are 1-based, matching the SAME human/model convention every
// other display surface in this codebase uses (tools/lsp.ts's own "POSITION CONVENTION" doc
// comment), not this client's own 0-based wire-level convention.
// -------------------------------------------------------------------------------------------

const SYMBOLS_CAP = 200; // token-conscious cap, parity with tools/lsp.ts's diagnostics/references/definition caps

// LSP SymbolKind (1-26, textDocument/documentSymbol + workspace/symbol share this enum).
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class", 6: "Method", 7: "Property",
  8: "Field", 9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function", 13: "Variable",
  14: "Constant", 15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event", 25: "Operator", 26: "TypeParameter",
};
function symbolKindName(kind: unknown): string {
  return SYMBOL_KIND_NAMES[Number(kind)] ?? "Symbol"; // defensive: a nonconforming server's out-of-range kind
}

// Caller contract: `lines` is always non-empty here — both call sites below already return the
// "no symbols found" sentinel before ever building `lines`, so this only ever caps a real list.
function capLines(lines: string[], cap: number): string {
  if (lines.length <= cap) return lines.join("\n");
  return `${lines.slice(0, cap).join("\n")}\n+${lines.length - cap} more`;
}

// textDocument/hover's `contents` is MarkupContent ({kind,value}) | MarkedString | MarkedString[]
// (MarkedString itself is `string | {language, value}` — deprecated but still emitted by some
// servers). This normalizes every shape to plain text.
function renderMarkedString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).value ?? "");
  return String(v);
}

function renderHover(res: unknown): string {
  const contents = (res as { contents?: unknown } | null)?.contents;
  if (contents == null) return "no hover info";
  const rendered = Array.isArray(contents)
    ? contents.map(renderMarkedString).filter((s) => s.length > 0).join("\n")
    : renderMarkedString(contents);
  return rendered.trim().length > 0 ? rendered : "no hover info";
}

// textDocument/documentSymbol answers with EITHER the hierarchical DocumentSymbol[] (name/kind/
// range/selectionRange/children?, no `location`) or the flat, older SymbolInformation[] (name/
// kind/location{uri,range}) — servers pick one shape for the whole response, never mixed, so a
// single check on the FIRST element decides how to render the rest.
function isFlatSymbolInformation(items: unknown[]): boolean {
  const first = items[0] as Record<string, unknown> | undefined;
  return !!first && typeof first === "object" && "location" in first;
}

function renderDocumentSymbolNode(sym: Record<string, unknown>, depth: number, lines: string[]): void {
  const range = (sym.range ?? sym.selectionRange) as { start?: { line?: number } } | undefined;
  const line0 = range?.start?.line ?? 0;
  lines.push(`${"  ".repeat(depth)}${symbolKindName(sym.kind)} ${sym.name} — line ${line0 + 1}`);
  const children = Array.isArray(sym.children) ? (sym.children as Record<string, unknown>[]) : [];
  for (const child of children) renderDocumentSymbolNode(child, depth + 1, lines);
}

function renderDocumentSymbols(res: unknown): string {
  if (!Array.isArray(res) || res.length === 0) return "no symbols found";
  const lines: string[] = [];
  if (isFlatSymbolInformation(res)) {
    for (const sym of res as Record<string, unknown>[]) {
      const loc = sym.location as { range?: { start?: { line?: number } } } | undefined;
      const line0 = loc?.range?.start?.line ?? 0;
      lines.push(`${symbolKindName(sym.kind)} ${sym.name} — line ${line0 + 1}`);
    }
  } else {
    for (const sym of res as Record<string, unknown>[]) renderDocumentSymbolNode(sym, 0, lines);
  }
  return capLines(lines, SYMBOLS_CAP);
}

// workspace/symbol answers are always flat (SymbolInformation[] or, per LSP 3.17, WorkspaceSymbol[]
// — same location shape for this repo's purposes) — no hierarchy, but each item carries its OWN
// file (unlike documentSymbols, which is scoped to one already-known file), so the path is part of
// the rendered line.
function renderWorkspaceSymbols(res: unknown): string {
  if (!Array.isArray(res) || res.length === 0) return "no symbols found";
  const lines = (res as Record<string, unknown>[]).map((sym) => {
    const loc = sym.location as { uri?: string; targetUri?: string; range?: { start?: { line?: number; character?: number } }; targetSelectionRange?: { start?: { line?: number; character?: number } } } | undefined;
    const uri = loc?.uri ?? loc?.targetUri;
    const range = loc?.range ?? loc?.targetSelectionRange;
    const line0 = range?.start?.line ?? 0;
    const char0 = range?.start?.character ?? 0;
    const path = uri ? uriToPath(uri) : "?";
    return `${symbolKindName(sym.kind)} ${sym.name} — ${path}:${line0 + 1}:${char0 + 1}`;
  });
  return capLines(lines, SYMBOLS_CAP);
}

interface Settler<T> { resolve: (v: T) => void; reject: (e: Error) => void }

/** One diagnostics() call awaiting a SETTLED result for its URI. `latest` accumulates across
 *  publishes; `settle` is the quiet-period timer (re-armed on every publish); `deadline` is the
 *  overall bound. Exactly one of the three finish paths runs (guarded by `done`): settle elapsed →
 *  resolve(latest); deadline with data → resolve(latest); deadline with no data → reject(timeout). */
interface DiagWaiter {
  resolve: (v: LspDiagnostic[]) => void;
  reject: (e: Error) => void;
  latest: LspDiagnostic[] | null;
  settle: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

export class LspClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private buf: Buffer = Buffer.alloc(0);
  private pending = new Map<number, Settler<any>>();
  // diagnostics() calls currently awaiting a SETTLED result for their URI — each publish updates
  // every waiter's `latest` and re-arms its settle timer (see DiagWaiter). Waiters are removed on
  // finish, not on first publish: real servers publish repeatedly per didOpen. There is deliberately
  // NO cross-call cache: each diagnostics() re-opens the on-disk content and settles fresh.
  private diagWaiters = new Map<string, DiagWaiter[]>();
  // ensureParsed() calls awaiting the FIRST publish for a just-opened URI — the server's
  // "I've parsed this document" signal. Position queries (definition/references) return null (or a
  // self-referential garbage location) against a document the server hasn't parsed, so they gate on
  // this before issuing the request. Distinct from diagWaiters (which settle for the LATEST publish).
  private readyWaiters = new Map<string, Settler<void>[]>();
  private openUris = new Set<string>();
  private stderrTail = "";
  private _dead = false;
  // Captured from InitializeResult.serverInfo.name (absent on some servers) — used purely to name
  // the offending server in an LspNotSupportedError message; never consulted for routing/behavior.
  private serverName: string | undefined;

  constructor(private readonly cfg: { command: string; args?: string[]; rootUri: string; startTimeoutMs?: number; diagSettleMs?: number; diagTimeoutMs?: number }) {}

  get alive(): boolean { return !this._dead; }

  async start(): Promise<void> {
    const timeoutMs = this.cfg.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const child = spawn(this.cfg.command, this.cfg.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.on("error", (e) => this.die(new LspServerExitedError(this.withStderr(`lsp server failed to start: ${e.message}`))));
    child.on("exit", (code, signal) => this.die(new LspServerExitedError(this.withStderr(`lsp server exited (code=${code} signal=${signal})`))));
    child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => {
      this.stderrTail = (this.stderrTail + s).slice(-STDERR_TAIL_MAX);
    });

    const initResult = await this.request("initialize", {
      processId: process.pid,
      rootUri: this.cfg.rootUri,
      capabilities: { textDocument: { publishDiagnostics: {}, definition: {}, references: {} } },
      workspaceFolders: [{ uri: this.cfg.rootUri, name: "root" }],
    }, timeoutMs);
    this.serverName = initResult?.serverInfo?.name;
    this.notify("initialized", {});
  }

  async diagnostics(fileUri: string, text: string, timeoutMs = this.cfg.diagTimeoutMs ?? DEFAULT_DIAG_TIMEOUT_MS): Promise<LspDiagnostic[]> {
    if (this._dead) return Promise.reject(new LspNotRunningError());
    const settleMs = this.cfg.diagSettleMs ?? DEFAULT_DIAG_SETTLE_MS;
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      const w: DiagWaiter = { resolve, reject, latest: null, settle: null, deadline: null, done: false };
      // Overall bound: with at least one publish in hand, resolve with it — interim data beats a
      // timeout error; a server still churning past the deadline gave us its best answer so far.
      // With NOTHING in hand, this is the genuine "server never published" hang → typed timeout.
      w.deadline = setTimeout(() => {
        if (w.latest !== null) this.finishDiag(fileUri, w, { ok: true, value: w.latest });
        else this.finishDiag(fileUri, w, { ok: false, error: new LspTimeoutError(`diagnostics for ${fileUri} timed out after ${timeoutMs}ms`) });
      }, timeoutMs);
      const waiters = this.diagWaiters.get(fileUri) ?? [];
      waiters.push(w);
      this.diagWaiters.set(fileUri, waiters);
      this.sendDidOpen(fileUri, text);
    });
  }

  /** Exactly-once finish for a diagnostics waiter: clears BOTH timers, removes it from the map,
   *  and settles its promise. Every path (settle elapsed, deadline, die()) funnels through here. */
  private finishDiag(uri: string, w: DiagWaiter, outcome: { ok: true; value: LspDiagnostic[] } | { ok: false; error: Error }): void {
    if (w.done) return;
    w.done = true;
    if (w.settle !== null) clearTimeout(w.settle);
    if (w.deadline !== null) clearTimeout(w.deadline);
    const list = this.diagWaiters.get(uri);
    if (list) {
      const i = list.indexOf(w);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.diagWaiters.delete(uri);
    }
    if (outcome.ok) w.resolve(outcome.value);
    else w.reject(outcome.error);
  }

  async definition(fileUri: string, text: string, line: number, character: number): Promise<LspLocation[]> {
    await this.ensureParsed(fileUri, text); // real servers only answer position queries for OPEN, parsed docs
    const res = await this.request("textDocument/definition", { textDocument: { uri: fileUri }, position: { line, character } }, DEFAULT_REQUEST_TIMEOUT_MS);
    return toLocations(res);
  }

  async references(fileUri: string, text: string, line: number, character: number): Promise<LspLocation[]> {
    await this.ensureParsed(fileUri, text);
    const res = await this.request(
      "textDocument/references",
      { textDocument: { uri: fileUri }, position: { line, character }, context: { includeDeclaration: true } },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    return toLocations(res);
  }

  /** textDocument/hover — type/doc info for the symbol at a position. Rides `ensureParsed` like
   *  `definition`/`references` (a server only answers position queries for an open, parsed doc).
   *  Returns an already-rendered string (see this file's own T1 doc comment above `renderHover`):
   *  a null/empty result renders "no hover info", never a thrown error — that's a legitimate,
   *  common answer (most positions have nothing to hover), not a capability gap. hover IS an
   *  optional LSP capability, though: a server that has never registered it answers -32601, which
   *  this rejects as a typed `LspNotSupportedError` instead (see `requestCapable`). */
  async hover(fileUri: string, text: string, line: number, character: number): Promise<string> {
    await this.ensureParsed(fileUri, text);
    const res = await this.requestCapable(
      "textDocument/hover",
      { textDocument: { uri: fileUri }, position: { line, character } },
      DEFAULT_REQUEST_TIMEOUT_MS,
      "hover",
    );
    return renderHover(res);
  }

  /** textDocument/documentSymbol — every symbol declared in one file. Rides `ensureParsed`: this
   *  is scoped to a specific open document just like a position query, even though it takes no
   *  line/character of its own. Handles BOTH response shapes a server may return (see
   *  `renderDocumentSymbols`'s own doc comment) and renders hierarchy as indentation. Optional
   *  capability → `LspNotSupportedError` on -32601. */
  async documentSymbols(fileUri: string, text: string): Promise<string> {
    await this.ensureParsed(fileUri, text);
    const res = await this.requestCapable(
      "textDocument/documentSymbol",
      { textDocument: { uri: fileUri } },
      DEFAULT_REQUEST_TIMEOUT_MS,
      "document symbols",
    );
    return renderDocumentSymbols(res);
  }

  /** workspace/symbol — search symbols BY NAME across the whole workspace. Deliberately does NOT
   *  call `ensureParsed`/`didOpen`: this isn't scoped to any one document, so there is no doc to
   *  open first (real servers answer this against their own project-wide index). Optional
   *  capability → `LspNotSupportedError` on -32601. */
  async workspaceSymbols(query: string): Promise<string> {
    const res = await this.requestCapable("workspace/symbol", { query }, DEFAULT_REQUEST_TIMEOUT_MS, "workspace symbol search");
    return renderWorkspaceSymbols(res);
  }

  /** textDocument/implementation — same request/response shape as `definition` (Location |
   *  Location[] | LocationLink[] | null), so it returns the SAME `LspLocation[]` for tools/lsp.ts
   *  to format identically (fence-checked preview, cap, "no X found"). Rides `ensureParsed` like
   *  `definition`/`references`. Optional capability → `LspNotSupportedError` on -32601. */
  async implementation(fileUri: string, text: string, line: number, character: number): Promise<LspLocation[]> {
    await this.ensureParsed(fileUri, text);
    const res = await this.requestCapable(
      "textDocument/implementation",
      { textDocument: { uri: fileUri }, position: { line, character } },
      DEFAULT_REQUEST_TIMEOUT_MS,
      "implementation",
    );
    return toLocations(res);
  }

  /** Wraps `request()` for the four OPTIONAL capabilities above (hover/documentSymbol/workspace-
   *  symbol/implementation): a server that never registered `method` answers with a JSON-RPC
   *  -32601 ("method not found") error — the standard signal per the LSP spec's capability
   *  negotiation model. That specific code is translated into a typed `LspNotSupportedError`
   *  naming the capability and (when known) the server; every OTHER rejection (timeout, a
   *  different RPC error, server death) passes through unchanged, since only -32601 means
   *  "unsupported" — anything else is a genuine failure the caller must still see as such. */
  private async requestCapable(method: string, params: unknown, timeoutMs: number, capability: string): Promise<any> {
    try {
      return await this.request(method, params, timeoutMs);
    } catch (e) {
      if (e instanceof LspRequestError && e.code === -32601) {
        throw new LspNotSupportedError(`${capability} not supported by ${this.serverName ?? "this language server"}`);
      }
      throw e;
    }
  }

  /** Guarantees the server has `fileUri` OPEN and PARSED before a position query. If it's already
   *  open in this warm client, returns at once. Otherwise sends didOpen and awaits the first
   *  publishDiagnostics for it (the parse-complete signal — empirically required: without it,
   *  tsserver/sourcekit-lsp return null or the cursor's own location for a cross-file definition).
   *  Best-effort: if no publish arrives within the diagnostics deadline, proceeds anyway rather than
   *  hang a turn — the subsequent request has its own timeout. */
  private ensureParsed(fileUri: string, text: string): Promise<void> {
    if (this._dead) return Promise.reject(new LspNotRunningError());
    if (this.openUris.has(fileUri)) return Promise.resolve();
    const timeoutMs = this.cfg.diagTimeoutMs ?? DEFAULT_DIAG_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const settle: Settler<void> = {
        resolve: () => { if (done) return; done = true; clearTimeout(timer); this.removeReadyWaiter(fileUri, settle); resolve(); },
        reject: (e) => { if (done) return; done = true; clearTimeout(timer); this.removeReadyWaiter(fileUri, settle); reject(e); },
      };
      const timer = setTimeout(() => settle.resolve(), timeoutMs); // no publish in time → proceed best-effort
      const arr = this.readyWaiters.get(fileUri) ?? [];
      arr.push(settle);
      this.readyWaiters.set(fileUri, arr);
      this.sendDidOpen(fileUri, text); // adds to openUris + notifies; the server publishes once parsed
    });
  }

  private removeReadyWaiter(uri: string, settle: Settler<void>): void {
    const arr = this.readyWaiters.get(uri);
    if (!arr) return;
    const i = arr.indexOf(settle);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.readyWaiters.delete(uri);
  }

  async stop(): Promise<void> {
    if (this._dead || !this.child) { this._dead = true; return; }
    const child = this.child;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
    });
    // Fire-and-forget: an unresponsive server's OWN internal request-timeout must NOT gate the
    // kill decision below. Earlier draft awaited this before racing against the outer timer —
    // since both used STOP_TIMEOUT_MS and the inner one is armed a tick earlier, it always won
    // the race and `clearTimeout`'d the outer timer, so SIGKILL never ran (a real server that
    // never responds to anything leaked its child process past the test — caught via `pgrep`
    // in an unrelated bash-tool test). The exit race below is the ONLY thing that decides kill.
    this.request("shutdown", {}, STOP_TIMEOUT_MS).then(() => this.notify("exit", {})).catch(() => { /* unresponsive; the race below force-kills regardless */ });
    await withTimeout(exited, STOP_TIMEOUT_MS, () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      return new LspTimeoutError("lsp did not exit after shutdown; force-killed");
    }).catch(() => { /* stop() is always best-effort and never throws; the process is dead or killed either way */ });
    this.die(new LspServerExitedError("stopped"));
  }

  /** SYNCHRONOUS best-effort kill — the daemon-SIGTERM backstop (5f whole-branch review). Unlike
   *  `stop()` (whose graceful shutdown request AND SIGKILL fallback are BOTH async — a `.then()`
   *  exit notification and a `STOP_TIMEOUT_MS` timer callback), this delivers a REAL `SIGTERM` to
   *  the child in the SAME synchronous tick, so it survives a `process.exit(0)` that runs
   *  immediately after (mirrors `mcp/client.ts`'s synchronous `stop()`). `die()` rejects every
   *  pending request/diagnostics waiter, which clears their per-request timeout timers. Idempotent
   *  and safe on an already-dead/never-started client (`die()` guards on `_dead`; `kill` on a gone
   *  child is caught). */
  killNow(): void {
    try { this.child?.stdin?.end(); } catch { /* ignore */ }
    try { this.child?.kill("SIGTERM"); } catch { /* already gone */ }
    this.die(new LspServerExitedError("killed"));
  }

  private sendDidOpen(uri: string, text: string): void {
    // LSP forbids re-opening an already-open document; close first so repeat diagnostics()
    // calls for the same uri (e.g. re-checking after an edit) stay protocol-legal.
    if (this.openUris.has(uri)) this.notify("textDocument/didClose", { textDocument: { uri } });
    this.openUris.add(uri);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageIdForUri(uri), version: 1, text } });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this._dead) return Promise.reject(new LspNotRunningError());
    const id = this.nextId++;
    const raw = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params }); // a synchronous throw here auto-rejects `raw` (Promise executor semantics)
    });
    return withTimeout(raw, timeoutMs, () => {
      this.pending.delete(id);
      return new LspTimeoutError(`lsp request "${method}" timed out after ${timeoutMs}ms`);
    });
  }

  private notify(method: string, params: unknown): void {
    try { this.send({ jsonrpc: "2.0", method, params }); } catch { /* best-effort; dead-state surfaces via pending rejections elsewhere */ }
  }

  private send(msg: unknown): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.child!.stdin!.write(header + body);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // no full header yet
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; } // malformed header; resync defensively
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) return; // partial frame; wait for more data
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + length);
      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return; // response to an id we no longer track (already timed out) — drop silently
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new LspRequestError(String(msg.error?.message ?? "lsp error"), msg.error?.code));
      else p.resolve(msg.result);
    } else if (msg && typeof msg.method === "string") {
      this.dispatchNotification(msg.method, msg.params);
    }
  }

  private dispatchNotification(method: string, params: any): void {
    if (method !== "textDocument/publishDiagnostics") return; // v1 scope: no other server-push methods consumed
    const uri = String(params?.uri ?? "");
    const diags = toDiagnostics(params?.diagnostics);
    // A publish means the server has parsed this doc — release any ensureParsed() readiness waiters.
    const ready = this.readyWaiters.get(uri);
    if (ready && ready.length) { for (const w of [...ready]) w.resolve(); }
    const waiters = this.diagWaiters.get(uri);
    if (!waiters || waiters.length === 0) return; // late publish after every waiter finished — drop
    const settleMs = this.cfg.diagSettleMs ?? DEFAULT_DIAG_SETTLE_MS;
    // Do NOT resolve on this publish: real servers publish more than once per didOpen (tsserver's
    // syntactic pass lands first and is often empty even when a type error follows). Record it as
    // the latest answer and (re)arm the quiet-period timer; the waiter resolves only once no
    // further publish has arrived for settleMs (or its overall deadline fires with data in hand).
    for (const w of [...waiters]) {
      w.latest = diags;
      if (w.settle !== null) clearTimeout(w.settle);
      w.settle = setTimeout(() => this.finishDiag(uri, w, { ok: true, value: w.latest! }), settleMs);
    }
  }

  private withStderr(message: string): string {
    return this.stderrTail ? `${message}: ${this.stderrTail}` : message;
  }

  private die(err: Error): void {
    if (this._dead) return;
    this._dead = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    // Snapshot per-URI lists: finishDiag splices the live arrays as it settles each waiter.
    for (const [uri, arr] of [...this.diagWaiters.entries()]) {
      for (const w of [...arr]) this.finishDiag(uri, w, { ok: false, error: err });
    }
    this.diagWaiters.clear();
    for (const arr of [...this.readyWaiters.values()]) for (const w of [...arr]) w.reject(err);
    this.readyWaiters.clear();
  }
}
