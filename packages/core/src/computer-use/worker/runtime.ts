// ComputerV2 (2026-10-08) — the script runtime INSIDE the sandboxed automation worker: the persistent store,
// the API globals a script sees (`apps`, `screen`, `App`, `print`, `show`, `sleep` and one error class per
// kind), compilation (JavaScript first, then TypeScript stripped), cancellation and error placement.
//
// No process I/O here — `entry.ts` owns stdin/stdout and the sandbox check — so the whole runtime is testable
// in-process with a fake `post`. Every API function is one `call` over the bridge; the daemon answers it.
//
// Script semantics (`repl.ts` has the transform): the body runs inside `with (__scope) { … }` over a Proxy of
// the store, so top-level declarations persist and may be redeclared, and top-level `await` just works.
// Sloppy mode, deliberately — `with` and block-level function hoisting need it.
import { AUTOMATION_ERROR_KINDS, type AutomationErrorKind } from "../errors";
import type { AppHandle, HostToWorker, ImageHandle, WorkerToHost } from "./bridge";
import { prepareScript, type PreparedScript } from "./repl";

export interface AutomationRuntimeDeps {
  post(message: WorkerToHost): void;
  /** Strip TypeScript syntax (Bun's transpiler, captured before `Bun` is withheld). Throws on a syntax error,
   *  ideally with `line`/`column` on the error or its `position`. Absent: JavaScript only. */
  transpile?(code: string): string;
}

/** What a script's stack frames are attributed to — how a thrown error is placed on a line of the script. */
const SCRIPT_URL = "winter-script";
/** Ambient names a script must not reach through the scope chain. Defense in depth only: the seatbelt is the
 *  boundary (no network, no writes, no Keychain), and sloppy-mode `this` can still reach the global object. */
const SHADOWED = ["process", "require", "module", "exports", "Bun", "globalThis", "global", "self", "fetch", "XMLHttpRequest", "WebSocket", "__filename", "__dirname", "Deno"];
/** A run's printed text beyond this many characters is dropped in the worker (the daemon caps at 64 KiB). */
const PRINT_CAP = 256 * 1024;
const SLEEP_MAX_MS = 30_000;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

interface Pending { resolve(v: unknown): void; reject(e: unknown): void; runId: string; site: string | undefined }
interface RunState { id: string; cancelled: boolean; reason: string; sleeps: Set<(e: unknown) => void>; printed: number; cut: boolean }

export interface AutomationRuntime {
  handle(message: HostToWorker): void;
  /** For tests: the persistent store. */
  readonly store: Record<string, unknown>;
}

export function createAutomationRuntime(deps: AutomationRuntimeDeps): AutomationRuntime {
  const store: Record<string, unknown> = Object.create(null);
  const has = (k: PropertyKey): boolean => typeof k === "string" && Object.prototype.hasOwnProperty.call(store, k);
  const scope = new Proxy(store, {
    has: (_t, k) => has(k),
    get: (_t, k) => (k === Symbol.unscopables ? undefined : has(k) ? store[k as string] : undefined),
    set: (_t, k, v) => { if (typeof k === "string") store[k] = v; return true; },
  });

  // ── typed errors ─────────────────────────────────────────────────────────────────────────────────
  class AutomationError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = new.target.name;
    }
  }
  const errorClasses = {} as Record<AutomationErrorKind, new (message?: string) => AutomationError>;
  for (const kind of AUTOMATION_ERROR_KINDS) {
    // A computed key names the class after its kind (`StaleRef.name === "StaleRef"`).
    errorClasses[kind] = ({ [kind]: class extends AutomationError {} })[kind]!;
  }
  const makeError = (kind: string, message: string): Error => {
    const cls = (errorClasses as Record<string, (new (m?: string) => AutomationError) | undefined>)[kind];
    if (cls !== undefined) return new cls(message);
    // A bad argument is the script's own bug: a plain `TypeError`, as a built-in would throw.
    return kind === "TypeError" ? new TypeError(message) : new Error(message);
  };

  // ── bridge calls ─────────────────────────────────────────────────────────────────────────────────
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let run: RunState | undefined;

  const plain = (v: unknown): unknown => {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x instanceof App ? undefined : x))); } catch { return undefined; }
  };

  const call = (primitive: string, target: string | undefined, args: Record<string, unknown> = {}): Promise<unknown> => {
    const r = run;
    if (r === undefined) return Promise.reject(new Error("no script is running"));
    if (r.cancelled) return Promise.reject(makeError("Cancelled", r.reason));
    // The CALL SITE, captured now while the script's own frame is on the stack, so a failure that arrives
    // later (from the bridge) can still be placed on the script line that made the call.
    const site = new Error().stack;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, runId: r.id, site });
      deps.post({ op: "call", id, runId: r.id, primitive, ...(target === undefined ? {} : { target }), args: (plain(args) ?? {}) as Record<string, unknown> });
    });
  };

  const withSite = (err: Error, site: string | undefined): Error => {
    if (site === undefined) return err;
    const frames = site.split("\n").slice(1).join("\n");
    try { Object.defineProperty(err, "stack", { value: `${err.name}: ${err.message}\n${frames}`, configurable: true, writable: true }); } catch { /* keep the original */ }
    return err;
  };

  // ── values crossing to the script ────────────────────────────────────────────────────────────────
  const images = new WeakMap<object, ImageHandle>();
  class Image {
    constructor(h: ImageHandle) {
      images.set(this, h);
      Object.defineProperties(this, { width: { value: h.width, enumerable: true }, height: { value: h.height, enumerable: true } });
      Object.freeze(this);
    }
    toString(): string { const h = images.get(this); return `[Image ${h?.width ?? "?"}×${h?.height ?? "?"}]`; }
  }
  const toImage = (v: unknown): Image => new Image(v as ImageHandle);

  const opts = (o: unknown): Record<string, unknown> => (o !== null && typeof o === "object" && !Array.isArray(o) ? { ...(o as Record<string, unknown>) } : {});
  const nothing = (): undefined => undefined;

  const targets = new WeakMap<object, string>();
  const tid = (app: object): string => targets.get(app) ?? "";
  class App {
    constructor(h: AppHandle) {
      targets.set(this, h.targetId);
      Object.defineProperties(this, { name: { value: h.name, enumerable: true }, bundleId: { value: h.bundleId, enumerable: true } });
    }
    state(o?: unknown) { return call("state", tid(this), opts(o)); }
    find(q: unknown, o?: unknown) { return call("find", tid(this), { query: q, ...opts(o) }); }
    screenshot(o?: unknown) { return call("screenshot", tid(this), opts(o)).then(toImage); }
    click(t: unknown, o?: unknown) { return call("click", tid(this), { target: t, ...opts(o) }).then(nothing); }
    setValue(ref: unknown, value: unknown) { return call("setValue", tid(this), { ref, value }).then(nothing); }
    type(text: unknown, o?: unknown) { return call("type", tid(this), { text, ...opts(o) }).then(nothing); }
    paste(text: unknown, o?: unknown) { return call("paste", tid(this), { text, ...opts(o) }).then(nothing); }
    key(combo: unknown, o?: unknown) { return call("key", tid(this), { combo, ...opts(o) }).then(nothing); }
    scroll(t: unknown, direction: unknown, pages?: unknown) { return call("scroll", tid(this), { target: t, direction, ...(pages === undefined ? {} : { pages }) }).then(nothing); }
    drag(from: unknown, to: unknown) { return call("drag", tid(this), { from, to }).then(nothing); }
    select(ref: unknown, text: unknown, o?: unknown) { return call("select", tid(this), { ref, text, ...opts(o) }).then(nothing); }
    action(ref: unknown, name: unknown) { return call("action", tid(this), { ref, name }).then(nothing); }
    menu(path: unknown) { return call("menu", tid(this), { path }).then(nothing); }
    hover(t: unknown, o?: unknown) { return call("hover", tid(this), { target: t, ...opts(o) }).then(nothing); }
    requestForeground(reason: unknown) { return call("requestForeground", tid(this), { reason }); }
    windows() { return call("windows", tid(this), {}); }
    useWindow(w: unknown) { return call("useWindow", tid(this), { window: w }).then(nothing); }
    waitFor(cond: unknown, o?: unknown) { return call("waitFor", tid(this), { cond, ...opts(o) }); }
    waitForIdle(o?: unknown) { return call("waitForIdle", tid(this), opts(o)); }
    applescript(source: unknown, o?: unknown) { return call("applescript", tid(this), { source, ...opts(o) }); }
    scriptingDictionary(o?: unknown) { return call("scriptingDictionary", tid(this), opts(o)); }
    toString(): string { return `[App ${(this as unknown as { name: string }).name}]`; }
  }
  const toApp = (v: unknown): App => new App(v as AppHandle);

  const apps = Object.freeze({
    list: (o?: unknown) => call("apps.list", undefined, opts(o)),
    open: (app: unknown, o?: unknown) => {
      const t = opts(o);
      // `app` is the target (an app name/bundle id, or a file path / URL to open); `{ app }` in the options
      // is the OPENER for a document, sent as `with` so it never clobbers the target.
      const extra: Record<string, unknown> = {};
      if (typeof t.app === "string") extra.with = t.app;
      if (t.window !== undefined) extra.window = t.window;
      return call("apps.open", undefined, { app, ...extra }).then(toApp);
    },
  });
  const screen = Object.freeze({
    screenshot: (o?: unknown) => call("screen.screenshot", undefined, opts(o)).then(toImage),
    windows: (o?: unknown) => call("screen.windows", undefined, opts(o)),
    appAt: (x: unknown, y: unknown) => call("screen.appAt", undefined, { x, y }).then(toApp),
  });

  const formatValue = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v === undefined) return "undefined";
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "symbol") return v.toString();
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (v instanceof Image || v instanceof App) return String(v);
    const seen = new WeakSet<object>();
    try {
      const s = JSON.stringify(v, (_k, x) => {
        if (typeof x === "bigint") return `${x}n`;
        if (x instanceof Image || x instanceof App) return String(x);
        if (x !== null && typeof x === "object") { if (seen.has(x)) return "[Circular]"; seen.add(x); }
        return x;
      }, 2);
      return s ?? String(v);
    } catch { return String(v); }
  };

  const print = (...values: unknown[]): void => {
    const r = run;
    if (r === undefined) return;
    let text = values.map(formatValue).join(" ");
    if (r.cut) return;
    if (r.printed + text.length > PRINT_CAP) { text = `${text.slice(0, Math.max(0, PRINT_CAP - r.printed))}\n[print output cut]`; r.cut = true; }
    r.printed += text.length;
    deps.post({ op: "print", runId: r.id, text });
  };
  const show = (image: unknown): void => {
    const r = run;
    if (r === undefined) return;
    if (!(image instanceof Image)) throw new TypeError("show() takes an image from screenshot()");
    deps.post({ op: "show", runId: r.id, image: images.get(image)!.image });
  };
  const sleep = (ms: unknown): Promise<void> => {
    const r = run;
    if (r === undefined) return Promise.resolve();
    if (r.cancelled) return Promise.reject(makeError("Cancelled", r.reason));
    const n = typeof ms === "number" && Number.isFinite(ms) ? Math.min(Math.max(0, ms), SLEEP_MAX_MS) : 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { r.sleeps.delete(cancel); resolve(); }, n);
      const cancel = (e: unknown): void => { clearTimeout(timer); reject(e); };
      r.sleeps.add(cancel);
    });
  };

  // The API, by the names a script sees. Passed as PARAMETERS of the script function (so a script cannot
  // reassign them for the next call — though a top-level declaration of the same name shadows one, by choice).
  /** The ms this run has left (its deadline, as extended, minus what has run; a card's wait does not count). */
  const timeLeft = (): Promise<unknown> => call("timeLeft", undefined, {});
  const API: Record<string, unknown> = { apps, screen, print, show, sleep, timeLeft, App, Image, AutomationError, ...errorClasses };
  const API_NAMES = Object.keys(API);
  const PARAMS = ["__scope", "__store", ...API_NAMES, ...SHADOWED];

  const compileBody = (prepared: PreparedScript): ((...a: unknown[]) => Promise<unknown>) => {
    const sync = prepared.functions.map((f) => `__store[${JSON.stringify(f)}] = ${f};`).join(" ");
    return new AsyncFunction(...PARAMS, `with (__scope) { ${sync}\n${prepared.body}\n}\n//# sourceURL=${SCRIPT_URL}`);
  };

  // The header lines the engine puts before the body: calibrated once, by placing a throw on script line 1
  // of a SYNCHRONOUS function built the same way (the same parameter list, the same one-line prelude).
  const lineOffset = ((): number => {
    try {
      // eslint-disable-next-line no-new-func
      new Function(...PARAMS, `with (__scope) { \nthrow new Error("calibrate")\n}\n//# sourceURL=${SCRIPT_URL}`)(scope, store);
    } catch (e) {
      const n = scriptLineOf(e, 0);
      if (n !== undefined) return n - 1;
    }
    return 3;
  })();
  function scriptLineOf(err: unknown, offset: number): number | undefined {
    const stack = err !== null && typeof err === "object" && typeof (err as { stack?: unknown }).stack === "string" ? (err as { stack: string }).stack : "";
    const m = new RegExp(`${SCRIPT_URL}:(\\d+)(?::\\d+)?`).exec(stack);
    if (m === null) return undefined;
    const line = Number(m[1]) - offset;
    return line >= 1 ? line : undefined;
  }

  interface Compiled { fn: (...a: unknown[]) => Promise<unknown>; prepared: PreparedScript; transpiled: boolean; note?: string }
  const compile = (code: string): Compiled | { error: { name: string; message: string; line?: number } } => {
    const tryJs = (src: string, transpiled: boolean): Compiled | undefined => {
      try {
        const prepared = prepareScript(src);
        return { fn: compileBody(prepared), prepared, transpiled };
      } catch { return undefined; }
    };
    const first = tryJs(code, false);
    if (first !== undefined) return first;
    let jsError: unknown;
    try { compileBody({ body: code, names: [], functions: [] }); } catch (e) { jsError = e; }
    if (deps.transpile !== undefined) {
      let js: string;
      try { js = deps.transpile(code); } catch (e) {
        const pos = (e as { position?: { line?: number; column?: number } }).position;
        const line = typeof (e as { line?: unknown }).line === "number" ? (e as { line: number }).line : pos?.line;
        return { error: { name: "SyntaxError", message: (e instanceof Error ? e.message : String(e)).replace(/^BuildMessage: /, ""), ...(typeof line === "number" && line >= 1 ? { line } : {}) } };
      }
      const second = tryJs(js, true);
      if (second !== undefined) return second;
      // The transform could not read this script, but the engine can: run it as written — its top-level
      // declarations will not outlive this call, and the daemon says so.
      try {
        const prepared = { body: js, names: [], functions: [] };
        return { fn: compileBody(prepared), prepared, transpiled: true, note: "declarations-not-kept" };
      } catch (e) { jsError ??= e; }
    } else if (jsError === undefined) {
      // Valid JavaScript the transform could not read (no transpiler here to retry with).
      const prepared = { body: code, names: [], functions: [] };
      return { fn: compileBody(prepared), prepared, transpiled: false, note: "declarations-not-kept" };
    }
    const message = jsError instanceof Error ? jsError.message : String(jsError ?? "the script could not be compiled");
    return { error: { name: "SyntaxError", message } };
  };

  /** Settle a run's outstanding calls: REJECTED `Cancelled` on a cancel (the script may be awaiting them), and
   *  RESOLVED quietly once the script has ended (nothing awaits them — a rejection would only be unhandled). */
  const settlePending = (runId: string, reason: string, how: "reject" | "drop"): void => {
    for (const [id, p] of pending) {
      if (p.runId !== runId) continue;
      pending.delete(id);
      if (how === "reject") p.reject(withSite(makeError("Cancelled", reason), p.site));
      else p.resolve(undefined);
    }
  };

  const runScript = async (runId: string, code: string): Promise<void> => {
    if (run !== undefined) {
      deps.post({ op: "done", runId, error: { name: "Error", message: "another script is still running in this session's runtime" } });
      return;
    }
    const compiled = compile(code);
    if ("error" in compiled) {
      deps.post({ op: "done", runId, error: compiled.error });
      return;
    }
    const state: RunState = { id: runId, cancelled: false, reason: "the script was cancelled", sleeps: new Set(), printed: 0, cut: false };
    run = state;
    for (const name of compiled.prepared.names) if (!has(name)) store[name] = undefined;
    let failure: { name: string; message: string; line?: number } | undefined;
    try {
      await compiled.fn.call(undefined, scope, store, ...API_NAMES.map((n) => API[n]), ...SHADOWED.map(() => undefined));
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      const message = e instanceof Error ? e.message : formatValue(e);
      const line = compiled.transpiled ? undefined : scriptLineOf(e, lineOffset);
      failure = { name, message, ...(line === undefined ? {} : { line }) };
    } finally {
      run = undefined;
      // A primitive the script started and never awaited does not outlive it.
      settlePending(runId, "the script ended before this call finished", "drop");
    }
    deps.post({ op: "done", runId, ...(failure === undefined ? {} : { error: failure }), ...(compiled.note === undefined ? {} : { note: compiled.note }) });
  };

  return {
    store,
    handle(message: HostToWorker): void {
      switch (message.op) {
        case "run":
          void runScript(message.runId, message.code);
          return;
        case "reply": {
          const p = pending.get(message.id);
          if (p === undefined) return;
          pending.delete(message.id);
          if (message.ok) p.resolve(message.value);
          else p.reject(withSite(makeError(message.error.kind, message.error.message), p.site));
          return;
        }
        case "cancel": {
          const r = run;
          if (r === undefined || r.id !== message.runId) return;
          r.cancelled = true;
          r.reason = message.reason ?? r.reason;
          settlePending(r.id, r.reason, "reject");
          for (const cancel of r.sleeps) cancel(makeError("Cancelled", r.reason));
          r.sleeps.clear();
          return;
        }
      }
    },
  };
}
