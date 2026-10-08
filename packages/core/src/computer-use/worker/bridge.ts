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
  /** Run `code` in the persistent runtime. One run at a time per worker (the daemon serializes them). */
  | { op: "run"; runId: string; code: string }
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
  | { op: "done"; runId: string; error?: { name: string; message: string; line?: number }; note?: string };

/** The primitives a script may call (Phase 1: apps and the whole screen; browsers are Phase 2). */
export const APP_PRIMITIVES = [
  "state", "find", "screenshot", "click", "setValue", "type", "paste", "key", "scroll", "drag", "select",
  "action", "menu", "windows", "useWindow", "waitFor", "waitForIdle",
] as const;
export const GLOBAL_PRIMITIVES = ["apps.list", "apps.open", "screen.screenshot", "screen.windows", "screen.appAt"] as const;
export type AppPrimitive = (typeof APP_PRIMITIVES)[number];
export type GlobalPrimitive = (typeof GLOBAL_PRIMITIVES)[number];
export type Primitive = AppPrimitive | GlobalPrimitive;

/** The handle a bound app crosses the bridge as; the worker wraps it in an `App`. */
export interface AppHandle { targetId: string; name: string; bundleId: string }
/** An opaque image handle: the bytes stay in the daemon. */
export interface ImageHandle { image: string; width: number; height: number }

/** One line is at most this long in either direction (a larger one is dropped and the run failed). */
export const BRIDGE_MAX_LINE = 4 * 1024 * 1024;
