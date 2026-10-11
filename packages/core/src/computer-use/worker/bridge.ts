// ComputerV2 (2026-10-08) — the NDJSON stdio bridge between the daemon and its sandboxed automation
// worker (`winter-core __automation-worker`), one JSON object per line in each direction.
//
// The worker never speaks to the helper, the network or the Keychain: every API function is ONE `call`
// the daemon answers after its own policy, locks and routing (`computer-use/service.ts`). Everything the
// worker writes is untrusted (the model's code shares its process and can write to stdout itself): a
// forged line can only do what the API already can — a `call` goes through the same policy, a `print` or
// `show` is output the daemon fences anyway, and a line naming another run is ignored.

/** Daemon → worker. */
export type HostToWorker =
  /** Run `code` in the persistent runtime. One run at a time per worker (the daemon serializes them). `install`: the
   *  session's saved scripts (`scripts.save`), sent on the first run to a FRESH worker — compiled and installed before
   *  `code` runs, so they outlive a reset, an idle end and a crash. */
  | { op: "run"; runId: string; code: string; install?: SavedScriptSource[] }
  /** The answer to a `call`. A failure carries the typed kind the worker throws as its class. */
  | { op: "reply"; id: number; ok: true; value?: unknown }
  | { op: "reply"; id: number; ok: false; error: { kind: string; message: string } }
  /** Interrupt or timeout: the in-flight primitive rejects `Cancelled`, and so does every later one. */
  | { op: "cancel"; runId: string; reason?: string };

/** Worker → daemon. */
export type WorkerToHost =
  /** The sandbox check passed and the runtime is listening. */
  | { op: "ready" }
  | { op: "call"; id: number; runId: string; primitive: string; target?: string; args?: Record<string, unknown> }
  | { op: "print"; runId: string; text: string }
  /** `show(image)` — an image handle the daemon minted for this session. */
  | { op: "show"; runId: string; image: string }
  /** The script settled. `error` is a throw that escaped it; `line` is the line in the model's script when
   *  the worker could place it. `note` is a daemon-facing remark (e.g. declarations not kept). */
  | { op: "done"; runId: string; error?: { name: string; message: string; line?: number }; note?: string; installFailed?: string[] };

/** The primitives a script may call (Phase 1: apps and the whole screen; browsers are Phase 2). */
export const APP_PRIMITIVES = [
  "state", "find", "screenshot", "click", "setValue", "type", "paste", "key", "scroll", "drag", "select",
  "action", "menu", "hover", "requestForeground", "windows", "useWindow", "waitFor", "waitForIdle", "applescript", "scriptingDictionary",
] as const;
export const GLOBAL_PRIMITIVES = ["apps.list", "apps.open", "screen.screenshot", "screen.windows", "screen.appAt", "timeLeft"] as const;
/** App adapters (Phase 2): `app.extras.<name>(…)`, `app.dict.<name>(…)`, `app.help(…)` — `adapters/`. */
export const EXTRA_PRIMITIVES = ["extra", "dict", "help"] as const;
/** Phase 2: a browser tab's primitives (`Tab`), and the `browsers` global's. */
export const TAB_PRIMITIVES = ["state", "find", "screenshot", "click", "setValue", "type", "paste", "key", "scroll", "drag",
  "select", "hover", "waitFor", "waitForIdle", "goto", "back", "forward", "reload", "url", "title", "text", "upload", "keep", "handoff", "close",
  // Phase 3
  "console", "network", "networkBody", "inspect", "html", "assets", "dialog", "answerDialog", "viewport", "mute", "download", "waitForUser"] as const;
export const BROWSER_PRIMITIVES = ["browsers.list", "browsers.open", "browsers.tabs", "browsers.tab", "browsers.windows", "browsers.group", "browsers.history", "browsers.bookmarks",
  // Phase 4
  "browsers.read"] as const;
/** Saved scripts (Phase 4): `scripts.save(name, fn)` and the bridge call a saved script makes as it starts. */
export const SCRIPT_PRIMITIVES = ["scripts.save", "scripts.run"] as const;
export type AppPrimitive = (typeof APP_PRIMITIVES)[number];
export type GlobalPrimitive = (typeof GLOBAL_PRIMITIVES)[number];
export type Primitive = AppPrimitive | GlobalPrimitive;

/** One function made for the bound app, as its handle names it, with its access class. */
export interface ExtraSpec { name: string; access: "view" | "click" | "full" }
/** The handle a bound app crosses the bridge as; the worker wraps it in an `App`. `extras` / `dict`: the names its
 *  `app.extras` / `app.dict` answer (filled at bind by `adapters/`). */
export interface AppHandle { targetId: string; name: string; bundleId: string; extras?: ExtraSpec[]; dict?: string[] }
/** The handle a bound browser tab crosses the bridge as; the worker wraps it in a `Tab`. `id` is the model-visible
 *  tab id ("winter:…", "chrome:…"), `targetId` the engine's own (`bt_…`). */
export interface TabHandle { kind: "tab"; targetId: string; id: string; browser: string }
/** An opaque image handle: the bytes stay in the daemon. */
export interface ImageHandle { image: string; width: number; height: number }

/** A saved script as the daemon keeps it and re-installs it: its name and its source text. */
export interface SavedScriptSource { name: string; source: string }
/** A saved script's name: a lowercase letter, then letters, digits or `_` — 48 characters at most. */
export const SAVED_SCRIPT_NAME = /^[a-z][A-Za-z0-9_]{0,47}$/;
/** Names `scripts.save` refuses: its own, and what `await`, printing or JSON would look up on an object. */
export const SAVED_SCRIPT_RESERVED: ReadonlySet<string> = new Set(["save", "then", "constructor", "toString", "valueOf", "toJSON", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]);
/** The limits (Phase 4 ruling): one script's source, the scripts one session keeps, and their sources in all (UTF-8). */
export const SAVED_SCRIPT_MAX_BYTES = 32 * 1024;
export const SAVED_SCRIPTS_MAX_COUNT = 32;
export const SAVED_SCRIPTS_MAX_TOTAL_BYTES = 256 * 1024;
/** The sentence for a source over the per-script limit (the worker says it before sending, the daemon after). */
export const savedScriptTooLarge = (bytes: number): string =>
  `a saved script is at most ${SAVED_SCRIPT_MAX_BYTES / 1024} KiB of source — this one is ${Math.ceil(bytes / 1024)} KiB`;
/** Whether `name` may name a saved script (the worker checks it, and the daemon again — the worker is untrusted). */
export const savedScriptNameOk = (name: unknown): name is string => typeof name === "string" && SAVED_SCRIPT_NAME.test(name) && !SAVED_SCRIPT_RESERVED.has(name);

/** One line is at most this long in either direction (a larger one is dropped and the run failed). */
export const BRIDGE_MAX_LINE = 4 * 1024 * 1024;
