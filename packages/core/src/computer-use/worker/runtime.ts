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
import { savedScriptShapeOk } from "./saved-shape";
import { SAVED_SCRIPT_MAX_BYTES, savedScriptNameOk, savedScriptTooLarge, type AppHandle, type HostToWorker, type ImageHandle, type SavedScriptSource, type TabHandle, type WorkerToHost } from "./bridge";
import { prepareScript, type PreparedScript } from "./repl";

export interface AutomationRuntimeDeps {
  post(message: WorkerToHost): void;
  /** Strip TypeScript syntax (Bun's transpiler, captured before `Bun` is withheld). Throws on a syntax error,
   *  ideally with `line`/`column` on the error or its `position`. Absent: JavaScript only. */
  transpile?(code: string): string;
}

/** What a script's stack frames are attributed to — how a thrown error is placed on a line of the script. */
const SCRIPT_URL = "winter-script";
/** A saved script's frames: `winter-saved:<name>` — how a throw inside one is placed on a line of ITS source. */
const SAVED_URL = "winter-saved:";
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
    try { return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x instanceof App || x instanceof Tab ? undefined : x))); } catch { return undefined; }
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
  /**
   * `app.extras` / `app.dict` (app adapters): frozen Proxies over the names the bind listed — a listed name is a
   * function (one bridge call; the daemon checks the name again), anything else `undefined`; `has` and `ownKeys`
   * answer the list, so `then`, symbols and `toJSON` are never callable and `await app.extras` is the object itself.
   */
  const callables = (kind: "extra" | "dict", names: readonly string[], targetId: string): Record<string, (...args: unknown[]) => Promise<unknown>> => {
    const listed = new Set(names.filter((n) => typeof n === "string" && n.length > 0));
    const fns = Object.create(null) as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const n of listed) {
      Object.defineProperty(fns, n, { value: (...args: unknown[]) => call(kind, targetId, { name: n, args }).then(kind === "extra" ? reviveApps : (v) => v), enumerable: true });
    }
    Object.freeze(fns);
    const own = (k: PropertyKey): k is string => typeof k === "string" && listed.has(k);
    return new Proxy(fns, {
      get: (_t, k) => (own(k) ? fns[k] : undefined),
      has: (_t, k) => own(k),
      ownKeys: () => [...listed],
      getOwnPropertyDescriptor: (_t, k) => (own(k) ? Object.getOwnPropertyDescriptor(fns, k) : undefined),
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      setPrototypeOf: () => false,
    });
  };
  /** An extra's result: each `{ $app: handle }` in it (an app window the extra bound, e.g. openWith's opener) becomes
   *  an App. The daemon checks the target id on every call made through it. */
  const reviveApps = (v: unknown, depth = 0): unknown => {
    if (depth > 4 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => reviveApps(x, depth + 1));
    const o = v as Record<string, unknown>;
    const h = o.$app as Partial<AppHandle> | undefined;
    if (Object.keys(o).length === 1 && h !== null && typeof h === "object" && typeof h.targetId === "string" && typeof h.name === "string" && typeof h.bundleId === "string") {
      return toApp(h);
    }
    for (const k of Object.keys(o)) o[k] = reviveApps(o[k], depth + 1);
    return o;
  };
  class App {
    constructor(h: AppHandle) {
      targets.set(this, h.targetId);
      Object.defineProperties(this, {
        name: { value: h.name, enumerable: true }, bundleId: { value: h.bundleId, enumerable: true },
        extras: { value: callables("extra", Array.isArray(h.extras) ? h.extras.map((e) => e?.name) : [], h.targetId) },
        dict: { value: callables("dict", Array.isArray(h.dict) ? h.dict : [], h.targetId) },
      });
    }
    help(topic?: unknown, o?: unknown) {
      // `help({ emit: false })`: options with no topic.
      if (topic !== null && typeof topic === "object" && !Array.isArray(topic) && o === undefined) { o = topic; topic = undefined; }
      return call("help", tid(this), { ...(topic === undefined ? {} : { topic }), ...opts(o) });
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

  // Phase 2: a browser tab. The same targets WeakMap as `App` (its handle never crosses as a plain object), the
  // shared `Target` methods, and the tab's own: navigation, its readable text, uploads, keep/close.
  class Tab {
    constructor(h: TabHandle) {
      targets.set(this, h.targetId);
      Object.defineProperties(this, { id: { value: h.id, enumerable: true }, browser: { value: h.browser, enumerable: true } });
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
    hover(t: unknown, o?: unknown) { return call("hover", tid(this), { target: t, ...opts(o) }).then(nothing); }
    waitFor(cond: unknown, o?: unknown) { return call("waitFor", tid(this), { cond, ...opts(o) }); }
    waitForIdle(o?: unknown) { return call("waitForIdle", tid(this), opts(o)); }
    url() { return call("url", tid(this), {}); }
    title() { return call("title", tid(this), {}); }
    goto(url: unknown) { return call("goto", tid(this), { url }).then(nothing); }
    back() { return call("back", tid(this), {}).then(nothing); }
    forward() { return call("forward", tid(this), {}).then(nothing); }
    reload() { return call("reload", tid(this), {}).then(nothing); }
    text(o?: unknown) { return call("text", tid(this), opts(o)); }
    upload(ref: unknown, paths: unknown) { return call("upload", tid(this), { ref, paths }).then(nothing); }
    console(o?: unknown) { return call("console", tid(this), opts(o)); }
    network(o?: unknown) { return call("network", tid(this), opts(o)); }
    networkBody(id: unknown, o?: unknown) { return call("networkBody", tid(this), { id, ...opts(o) }); }
    inspect(t: unknown, o?: unknown) { return call("inspect", tid(this), { target: t, ...opts(o) }); }
    html(o?: unknown) { return call("html", tid(this), opts(o)); }
    assets(o?: unknown) { return call("assets", tid(this), opts(o)); }
    dialog() { return call("dialog", tid(this), {}); }
    answerDialog(accept: unknown, text?: unknown) { return call("answerDialog", tid(this), { accept, ...(text === undefined ? {} : { text }) }).then(nothing); }
    keep(o?: unknown) { return call("keep", tid(this), opts(o)).then(nothing); }
    viewport(size: unknown) { return call("viewport", tid(this), { size: size === undefined ? null : size }).then(nothing); }
    mute(on?: unknown) { return call("mute", tid(this), on === undefined ? {} : { on }).then(nothing); }
    download(t: unknown, o?: unknown) { return call("download", tid(this), { target: t, ...opts(o) }); }
    waitForUser(reason: unknown, o?: unknown) { return call("waitForUser", tid(this), { reason, ...opts(o) }); }
    handoff() { return call("handoff", tid(this), {}).then(nothing); }
    close() { return call("close", tid(this), {}).then(nothing); }
    toString(): string { return `[Tab ${(this as unknown as { id: string }).id}]`; }
  }
  const toTab = (v: unknown): Tab => new Tab(v as TabHandle);

  const apps = Object.freeze({
    list: (o?: unknown) => call("apps.list", undefined, opts(o)),
    open: (app: unknown, o?: unknown) => {
      const t = opts(o);
      // `app` is the target (an app name/bundle id, or a file path / URL to open); `{ app }` in the options
      // is the OPENER for a document, sent as `with` so it never clobbers the target.
      const extra: Record<string, unknown> = {};
      if (typeof t.app === "string") extra.with = t.app;
      if (t.window !== undefined) extra.window = t.window;
      if (t.emit === false) extra.emit = false;
      return call("apps.open", undefined, { app, ...extra }).then(toApp);
    },
  });
  const browsers = Object.freeze({
    list: (o?: unknown) => call("browsers.list", undefined, opts(o)),
    open: (url: unknown, o?: unknown) => call("browsers.open", undefined, { url, ...opts(o) }).then(toTab),
    tabs: (o?: unknown) => call("browsers.tabs", undefined, opts(o)),
    tab: (t: unknown, o?: unknown) => call("browsers.tab", undefined, { tab: t, ...opts(o) }).then(toTab),
    windows: (o?: unknown) => call("browsers.windows", undefined, opts(o)),
    group: (o?: unknown) => call("browsers.group", undefined, opts(o)).then(nothing),
    history: (o?: unknown) => call("browsers.history", undefined, opts(o)),
    bookmarks: (o?: unknown) => call("browsers.bookmarks", undefined, opts(o)),
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
    if (v instanceof Image || v instanceof App || v instanceof Tab) return String(v);
    const seen = new WeakSet<object>();
    try {
      const s = JSON.stringify(v, (_k, x) => {
        if (typeof x === "bigint") return `${x}n`;
        if (x instanceof Image || x instanceof App || x instanceof Tab) return String(x);
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

  // ── saved scripts (Phase 4) ──────────────────────────────────────────────────────────────────────────
  // `scripts.save(name, fn)` keeps a function for the rest of the SESSION; `scripts.<name>(…)` runs it. What runs is
  // always the function RE-CREATED from its source (here at save, and in a fresh worker from the daemon's copy on its
  // first call), never the original closure — so it behaves the same before and after a restart, and one that relied
  // on a variable it closed over fails at its first call, not mysteriously later. `scripts` reveals nothing: no keys,
  // no listing, no source (a product rule — the source was in the model's own call; nothing relies on it being secret).
  //
  // A stored source is text that later workers evaluate, so it is held to three rules:
  //  1. it is read only through `Function.prototype.toString` and `Reflect.apply` as they were BEFORE any script ran
  //     (a script can replace both) — captured here;
  //  2. it has one shape — exactly one function or arrow expression (`saved-shape.ts`, checked again by the daemon),
  //     whose evaluation runs nothing;
  //  3. installing is INERT: a fresh worker only stores the daemon's copy; the first `scripts.<name>(…)` re-creates the
  //     function and runs it only if the re-created function's own source is exactly the stored text.
  // A FORGED bridge save (the model's code can write bridge lines itself) can still store any source the daemon's
  // checks accept; rules 2 and 3 keep what it can do to running that one function when it is called by name — the
  // same thing the model could do by running the code directly — never at a worker's start or after a reset.
  const fnToString = Function.prototype.toString;
  const reflectApply = Reflect.apply;
  const FunctionCtor = Function;
  const sourceOf = (fn: unknown): string => reflectApply(fnToString, fn, []) as string;
  interface SavedEntry { source: string; fn?: (...a: unknown[]) => unknown }
  const saved = new Map<string, SavedEntry>();
  const wrappers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const wrapperSet = new WeakSet<object>();
  /** Re-create a saved function from its source, in this runtime: free names resolve, when it runs, to the
   *  top-level declarations then (the persistent scope) and the built-in API — nothing else it closed over. Only
   *  ever called on a source of the one shape (rule 2), and the result is checked against it (rule 3). */
  const compileSaved = (name: string, source: string): ((...a: unknown[]) => unknown) => {
    // eslint-disable-next-line no-new-func
    const make = new FunctionCtor(...PARAMS, `with (__scope) { return (\n${source}\n); }\n//# sourceURL=${SAVED_URL}${name}`) as (...a: unknown[]) => unknown;
    const fn = reflectApply(make, undefined, [scope, store, ...API_NAMES.map((n) => API[n]), ...SHADOWED.map(() => undefined)]) as unknown;
    if (typeof fn !== "function" || sourceOf(fn) !== source) throw new TypeError("not the saved function");
    return fn as (...a: unknown[]) => unknown;
  };
  const wrapperFor = (name: string): ((...a: unknown[]) => Promise<unknown>) => {
    let w = wrappers.get(name);
    if (w !== undefined) return w;
    w = async (...args: unknown[]): Promise<unknown> => {
      const entry = saved.get(name);
      if (entry === undefined) throw new TypeError(`scripts.${name} is not a function`);
      if (entry.fn === undefined) {
        try { entry.fn = compileSaved(name, entry.source); } catch {
          saved.delete(name);
          throw new TypeError(`scripts.${name} could not be re-created in this runtime — save it again`);
        }
      }
      // The daemon hears of the run first: it counts it, and a cancelled run stops it before it starts.
      await call("scripts.run", undefined, { name });
      return await entry.fn(...args);
    };
    Object.defineProperty(w, "name", { value: name });
    Object.defineProperty(w, "toString", { value: () => `function ${name}() { [saved script] }` });
    wrappers.set(name, w);
    wrapperSet.add(w);
    return w;
  };
  const saveScript = async (name: unknown, fn: unknown): Promise<void> => {
    if (!savedScriptNameOk(name)) {
      throw new TypeError("scripts.save() takes a name that starts with a lowercase letter, then letters, digits or _ (at most 48), and is not save, then, toString or another built-in name");
    }
    if (typeof fn !== "function") throw new TypeError("scripts.save() takes a function written in your script");
    if (wrapperSet.has(fn)) {
      throw new TypeError("that is a saved script already — to keep it under another name too, save a function that calls it: scripts.save(\"other\", (...a) => scripts.<its name>(...a))");
    }
    const source = sourceOf(fn);
    if (/\[native code\]\s*\}\s*$/.test(source)) throw new TypeError("scripts.save() takes a function written in your script");
    if (/^class\b/.test(source.trimStart())) throw new TypeError("scripts.save() takes a function, not a class");
    // Said here, before a source too large for the daemon could be sent at all (the daemon checks again).
    const bytes = new TextEncoder().encode(source).length;
    if (bytes > SAVED_SCRIPT_MAX_BYTES) throw new TypeError(savedScriptTooLarge(bytes));
    const notShaped = "scripts.save() could not re-create that function from its source — write it as an arrow or function expression: scripts.save(\"name\", async (a, b) => { … })";
    if (!savedScriptShapeOk(source)) throw new TypeError(notShaped);
    let compiled: (...a: unknown[]) => unknown;
    try { compiled = compileSaved(name, source); } catch { throw new TypeError(notShaped); }
    await call("scripts.save", undefined, { name, source });
    saved.set(name, { source, fn: compiled });
  };
  const scripts = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (k === "save" ? saveScript : typeof k === "string" && saved.has(k) ? wrapperFor(k) : undefined),
    has: (_t, k) => k === "save",
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  /** The daemon's copy, into a fresh worker before its first run: STORED, never evaluated here (rule 3). The names
   *  left out (a name or shape the daemon should never have kept) are reported. */
  const install = (entries: readonly SavedScriptSource[] | undefined): string[] => {
    const failed: string[] = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      if (e === null || typeof e !== "object" || !savedScriptNameOk(e.name)) continue;
      if (typeof e.source !== "string" || !savedScriptShapeOk(e.source)) { failed.push(e.name); continue; }
      saved.set(e.name, { source: e.source });
    }
    return failed;
  };

  // The API, by the names a script sees. Passed as PARAMETERS of the script function (so a script cannot
  // reassign them for the next call — though a top-level declaration of the same name shadows one, by choice).
  /** The ms this run has left (its deadline, as extended, minus what has run; a card's wait does not count). */
  const timeLeft = (): Promise<unknown> => call("timeLeft", undefined, {});
  const API: Record<string, unknown> = { apps, browsers, screen, scripts, print, show, sleep, timeLeft, App, Tab, Image, AutomationError, ...errorClasses };
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
  // A saved script's own header lines, calibrated the same way: a throw on line 1 of a saved source.
  const savedLineOffset = ((): number => {
    try {
      // eslint-disable-next-line no-new-func
      // "-calibrate": a sourceURL no saved script's name can produce (a name starts with a lowercase letter).
      (new Function(...PARAMS, `with (__scope) { return (\n() => { throw new Error("calibrate") }\n); }\n//# sourceURL=${SAVED_URL}-calibrate`)(scope, store) as () => void)();
    } catch (e) {
      const m = /winter-saved:-calibrate:(\d+)/.exec(e instanceof Error ? e.stack ?? "" : "");
      if (m !== null) return Number(m[1]) - 1;
    }
    return 3;
  })();
  /** "(in saved script exportCsv, line 3)" when the throw happened inside a saved script's own code. */
  const savedPlace = (err: unknown): string | undefined => {
    const stack = err !== null && typeof err === "object" && typeof (err as { stack?: unknown }).stack === "string" ? (err as { stack: string }).stack : "";
    const m = /winter-saved:([a-z][A-Za-z0-9_]{0,47}):(\d+)/.exec(stack);
    if (m === null) return undefined;
    const line = Number(m[2]) - savedLineOffset;
    return line >= 1 ? `(in saved script ${m[1]}, line ${line})` : `(in saved script ${m[1]})`;
  };
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

  const runScript = async (runId: string, code: string, toInstall?: readonly SavedScriptSource[]): Promise<void> => {
    // A fresh worker's saved scripts first, whatever the script itself turns out to be.
    const failedInstall = toInstall === undefined ? [] : install(toInstall);
    const installed = failedInstall.length === 0 ? {} : { installFailed: failedInstall };
    if (run !== undefined) {
      deps.post({ op: "done", runId, error: { name: "Error", message: "another script is still running in this session's runtime" }, ...installed });
      return;
    }
    const compiled = compile(code);
    if ("error" in compiled) {
      deps.post({ op: "done", runId, error: compiled.error, ...installed });
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
      const where = savedPlace(e);
      const message = `${e instanceof Error ? e.message : formatValue(e)}${where === undefined ? "" : ` ${where}`}`;
      const line = compiled.transpiled ? undefined : scriptLineOf(e, lineOffset);
      failure = { name, message, ...(line === undefined ? {} : { line }) };
    } finally {
      run = undefined;
      // A primitive the script started and never awaited does not outlive it.
      settlePending(runId, "the script ended before this call finished", "drop");
    }
    deps.post({ op: "done", runId, ...(failure === undefined ? {} : { error: failure }), ...(compiled.note === undefined ? {} : { note: compiled.note }), ...installed });
  };

  return {
    store,
    handle(message: HostToWorker): void {
      switch (message.op) {
        case "run":
          void runScript(message.runId, message.code, message.install);
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
