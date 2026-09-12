import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket,
} from "@yanlinglabs/winter-protocol";

/**
 * `@yanlinglabs/winter-plugin-sdk` — the Tier-2 plugin authoring library (design spec §4, plan Phase 4b
 * Task 5). `createPlugin({tools, onShortcut, tile}).serve()` owns the WHOLE lifecycle contract
 * (connect, hello, register, dispatch, reconnect, clean shutdown) so a plugin author never has
 * to implement it themselves — see the class doc below for the exact wire sequence.
 *
 * SELF-CONTAINED BY DESIGN: this package imports wire *types* from `@yanlinglabs/winter-protocol` (a
 * declared dependency) but never `packages/core` — a plugin process is a separate OS process the
 * supervisor spawns (packages/core/src/plugins/supervisor.ts), so pulling in core's daemon
 * machinery here would be both wrong (core is a server, this is a client) and a dependency
 * cycle risk. The NDJSON framing/request-response correlation below is a small, deliberately
 * duplicated mirror of `packages/cli/src/client.ts`'s `WinterClient` — same shapes over the wire,
 * independent implementation, so plugin authors installing this package never pull in the CLI or
 * core.
 */

// -------------------------------------------------------------------------------------------
// Public surface (plan Task 5 "Produces" — the createPlugin signature is the contract).
// -------------------------------------------------------------------------------------------

export interface PluginToolDef {
  description: string;
  /** Raw JSON-schema-shaped record, passed to core verbatim (protocol's `ToolRegisterParams.
   *  parameters` — core does not re-validate its shape beyond "is an object"). Omit for a
   *  schema-less tool (still registrable — spec §3 "optionally deferred JSON schema"). */
  parameters?: Record<string, unknown>;
  /** Handler for a `plugin_tool_invoke` dispatch. Sync or async; a thrown error (or a rejected
   *  promise) becomes `plugin.toolResult {error: message}`; a returned value is JSON.stringified
   *  into `plugin.toolResult {resultJson}`. The second arg, `ctx`, is a fixed-shape helper bag
   *  (currently just `hardware`) — additive-only over the original single-arg `run(args)` shape:
   *  a handler that ignores it (`(args) => ...` or `() => ...`) keeps compiling and running
   *  unchanged, since a function expecting fewer parameters is assignable wherever one expecting
   *  more is (TS's structural function-type variance) — see examples/sample-echo/index.ts, which
   *  never touches `ctx` and still typechecks. */
  run: (args: unknown, ctx: PluginContext) => unknown | Promise<unknown>;
}

/** Phase 4c Task 5 (design spec §5): the helper bag every tool `run` handler receives as its
 *  second argument. Today this is just `hardware` — a plugin's own escape hatch into core's
 *  `hardware.request` broker (Phase 4c Task 2) for verbs like `setChargeLimit`/`getChargeLimit`,
 *  routed through Winter.app's privileged XPC helper. Kept as its own named interface (not inlined
 *  into `PluginToolDef.run`'s signature) because it's public surface a plugin author imports and
 *  destructures directly. */
export interface PluginContext {
  /** Calls one hardware verb through core's `hardware.request` JSON-RPC method (wraps this
   *  module's own `request()` seam — same socket, same pending-map correlation, nothing new on
   *  the wire). `args` is JSON.stringified into `argsJson` (`{}` when omitted, never left
   *  undefined — core's `HardwareRequestParams.argsJson` is optional but a plugin author calling
   *  `ctx.hardware("getChargeLimit")` with no args shouldn't have to think about that). On success
   *  (`{resultJson}`), JSON.parses `resultJson` and resolves with the parsed value. On any of the
   *  five typed-failure variants (`unknown_verb`, `consent_denied`, `no_provider`, `timeout`,
   *  `provider_error` — packages/protocol/src/methods.ts's `HardwareRequestResult` union), THROWS
   *  an `Error` whose message names the `code` (plus `missing`/`message` when the variant carries
   *  one) rather than resolving with an error-shaped value — a thrown error is exactly what
   *  `handleInvoke` below already turns into a typed `plugin.toolResult {error}` for every other
   *  tool failure, so a `run` handler that doesn't itself catch this propagates the SAME way a
   *  plain `throw new Error(...)` inside its own body would. Never swallows a failure into a
   *  success-shaped return. */
  hardware(verb: string, args?: unknown): Promise<unknown>;
  /** Phase 4d-i Task 3: a plugin's own escape hatch to push a FRESH tile MID-SESSION, over the
   *  SAME `request()` seam `hardware` above uses (`tile.update`, same wire shape `def.tile()`'s
   *  once-at-connect push already sends — see `PluginDefinition.tile`'s doc comment). This is
   *  additive to, not a replacement for, that once-at-connect paint: `def.tile` still fires once
   *  right after every (re)registration (so a freshly-(re)connected core always has SOMETHING
   *  rather than nothing until the plugin's next voluntary event), and a tool handler (or any
   *  other in-process code holding this `ctx`) can call `updateTile` any time thereafter to push
   *  an updated value — e.g. the 4b "battery-limiter tile shows unknown" bug, where the tile could
   *  only ever be painted once at connect and had no way to reflect a value that changes over the
   *  life of the connection. Resolves/rejects exactly like `hardware()` (not-connected rejection,
   *  10s default timeout, reconnect-safe pending-map cleanup) since it's the same `request()` call
   *  underneath. */
  updateTile(tile: Record<string, unknown>): Promise<void>;
}

export interface PluginDefinition {
  tools?: Record<string, PluginToolDef>;
  /** In 4b this callback was accepted and stored but never invoked (shortcut invocation routing
   *  was deferred to Phase 4d). As of Phase 4d-i Task 3 it IS invoked: whenever core pushes a
   *  `shortcut_invoke {shortcutId}` event to this plugin's connection (Phase 4d-i Task 2's
   *  harness->plugin push — a future UI firing one of this plugin's registered shortcuts), the
   *  dispatch loop in `connectOnce` calls `onShortcut(shortcutId, ctx)`. The second arg, `ctx`, is
   *  the same fixed-shape helper bag `PluginToolDef.run` receives (`hardware`/`updateTile`) — it
   *  lets a shortcut fired BEFORE any tool call still push a live tile update, rather than having
   *  to stash `ctx` from a prior tool invocation. Additive-only over the original single-arg
   *  `onShortcut(id)` shape, same structural-variance reasoning as `PluginToolDef.run`'s `ctx`
   *  (see that doc comment): a handler that ignores it keeps compiling and running unchanged.
   *  Fire-and-forget: there is no reply back to core for this event (unlike `plugin_tool_invoke`,
   *  which always gets a `plugin.toolResult`), so a throw inside this callback is NOT
   *  caught/reported anywhere — same posture as any other synchronous callback a plugin author
   *  supplies.
   *
   *  Independently of dispatch, if this is set, `serve()` also registers whatever shortcut ids
   *  the plugin's own `winter-plugin.json` (`contributes.shortcuts`, design spec §1/§6 — "plugins
   *  declare shortcut IDs in the manifest") declares, via `shortcut.register`, on every
   *  (re)registration. Reading the manifest is a plain `fs.readFileSync` off `process.cwd()` (the
   *  supervisor spawns each plugin process cwd'd into its own plugin directory) — never a
   *  `packages/core` import, and never throws: a missing/malformed manifest or an empty/absent
   *  `shortcuts` list just means nothing gets registered this cycle. */
  onShortcut?: (id: string, ctx: PluginContext) => void;
  /** Phase 4d-i Task 3: invoked whenever core pushes a `tile_action {actionId}` event to this
   *  plugin's connection (Phase 4d-i Task 2's harness->plugin push — a future UI clicking one of
   *  this plugin's declarative tile's action buttons). Same second-arg `ctx` and fire-and-forget
   *  posture as `onShortcut` above — no reply is sent back to core for this event, and dispatch
   *  never registers anything on this callback's behalf (there's no manifest-declared analog to
   *  `contributes.shortcuts` for tile actions; the tile's own shape, returned from `tile()`
   *  below, is what declares its actions). */
  onTileAction?: (actionId: string, ctx: PluginContext) => void;
  /** When set, `serve()` calls this and pushes one `tile.update` immediately after registration
   *  completes — including after every reconnect (core restarts wipe its in-memory contrib
   *  registry, so a stale tile would otherwise linger until the plugin's next voluntary push).
   *  This is the ONE-TIME initial paint only. For pushing a fresh tile mid-session (the value
   *  changes while the connection stays up — e.g. the 4b "battery-limiter tile shows unknown"
   *  bug, where the tile had no way to reflect a value that changes over the life of the
   *  connection), see `PluginContext.updateTile` (Phase 4d-i Task 3): a tool `run` handler (or
   *  any other in-process code holding a `ctx`) can call `ctx.updateTile(tile)` any time after
   *  connect to push a live update, independently of this once-at-connect paint. */
  tile?: () => Record<string, unknown>;
}

export interface ServeOptions {
  /** Defaults to `WINTER_SOCKET`. */
  socketPath?: string;
  /** Defaults to `WINTER_PLUGIN_TOKEN`. */
  token?: string;
  /** Defaults to `WINTER_PLUGIN_ID`. */
  pluginId?: string;
}

export interface Plugin {
  /** Connects, hellos as role "plugin", registers everything declared in the `createPlugin` def,
   *  and starts the dispatch loop. Resolves once the FIRST full registration cycle succeeds (the
   *  connection then keeps running/dispatching/reconnecting in the background — nothing further
   *  needs to be awaited). Rejects only for a static configuration error (a socketPath/token/
   *  pluginId that resolves to neither an option nor an env var) — an actual connection failure
   *  is retried with backoff, never surfaced as a rejection, matching "core restart resilience". */
  serve(opts?: ServeOptions): Promise<void>;
  /** Deliberate shutdown: stops any pending reconnect, closes the socket, removes the
   *  SIGTERM/SIGINT handlers `serve()` installed. Idempotent. Does NOT call `process.exit` itself
   *  — the installed signal handlers do that (spec: "SIGTERM/SIGINT: close socket, exit 0"); a
   *  caller invoking `close()` directly (e.g. tests, or a plugin author's own shutdown path) gets
   *  a clean disconnect without the process being killed out from under it. */
  close(): void;
}

// -------------------------------------------------------------------------------------------
// Reconnect backoff — spec: "1s·2ⁿ backoff cap 30s" (the SDK side; core's own supervisor uses a
// DIFFERENT cap, 60s — see supervisor.ts's `backoffDelayMs`, an intentionally separate constant
// for a separate process). Pure + exported for direct testing, same discipline as core's.
// -------------------------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;

export function backoffDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_CAP_MS);
}

// -------------------------------------------------------------------------------------------
// Final-review Fix B1: a `hello` that comes back UNAUTHORIZED (a rotated/revoked token for this
// pluginId) means this process incarnation is permanently superseded — reconnecting forever would
// just hammer the server with credentials that will never become valid again. `FatalAuthError` is
// thrown ONLY from the hello step inside `connectOnce` (never from register/tool.register/etc —
// those failures, e.g. "duplicate tool", stay ordinary reconnect-with-backoff cases) so
// `attemptConnect`'s catch can tell "give up and exit" apart from "retry" by `instanceof`, not by
// sniffing error message text at the call site.
// -------------------------------------------------------------------------------------------

class FatalAuthError extends Error {}

/** True when `err` is a `request()` rejection whose JSON-RPC error code was ERR.UNAUTHORIZED —
 *  `request()`'s rejection message is `${message} (code ${code})` (see below), so this is a plain
 *  substring check rather than a structured field; nothing else constructs a rejection in that
 *  exact shape. */
function isUnauthorizedRpcError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(`(code ${ERR.UNAUTHORIZED})`);
}

// -------------------------------------------------------------------------------------------
// Manifest-declared shortcut ids (see PluginDefinition.onShortcut's doc comment above).
// -------------------------------------------------------------------------------------------

interface DeclaredShortcut { id: string; description?: string; default?: string }

function readDeclaredShortcuts(): DeclaredShortcut[] {
  try {
    const pluginDir = process.env.WINTER_PLUGIN_DIR ?? process.cwd();
    const raw = readFileSync(join(pluginDir, "winter-plugin.json"), "utf8");
    const parsed = JSON.parse(raw) as { contributes?: { shortcuts?: unknown } };
    const shortcuts = parsed.contributes?.shortcuts;
    if (!Array.isArray(shortcuts)) return [];
    const out: DeclaredShortcut[] = [];
    for (const s of shortcuts) {
      if (!s || typeof s !== "object") continue;
      const id = (s as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) continue;
      const entry: DeclaredShortcut = { id };
      const description = (s as Record<string, unknown>).description;
      if (typeof description === "string") entry.description = description;
      const def = (s as Record<string, unknown>).default;
      if (typeof def === "string") entry.default = def;
      out.push(entry);
    }
    return out;
  } catch {
    return []; // missing/malformed manifest: never bricks (same posture as core's loadManifest)
  }
}

// -------------------------------------------------------------------------------------------
// createPlugin.
// -------------------------------------------------------------------------------------------

type PendingEntry = { resolve: (v: unknown) => void; reject: (e: Error) => void };

// -------------------------------------------------------------------------------------------
// `hardware.request`'s wire result union — a local TS type kept independent of
// `@yanlinglabs/winter-protocol`'s `HardwareRequestResult` zod schema (methods.ts), same precedent as core's
// own `packages/core/src/peripheral/hardware.ts` (`HardwareRequestResult` there): coverage that
// the two stay in sync lives in tests (this package's + core's), not the type system. This SDK
// never zod-parses ANY RPC result (see `request()` above, `Promise<unknown>` throughout) — adding
// a zod dependency just for this one wire shape would be inconsistent with that.
// -------------------------------------------------------------------------------------------

type HardwareRequestWireResult =
  | { resultJson: string }
  | { code: "unknown_verb" }
  | { code: "consent_denied"; missing?: string }
  | { code: "no_provider"; message: string }
  | { code: "timeout" }
  | { code: "provider_error"; message: string };

export function createPlugin(def: PluginDefinition): Plugin {
  let socketPath: string | undefined;
  let token: string | undefined;
  let pluginId: string | undefined;

  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  let writer: ConnWriter | null = null;
  let decoder = new LineDecoder();
  let nextId = 1;
  const pending = new Map<number, PendingEntry>();

  let closed = false;
  let serving = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let firstConnectResolve: (() => void) | null = null;

  let sigtermHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;

  function request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!writer) return Promise.reject(new Error(`plugin-sdk: not connected (method ${method})`));
    const id = nextId++;
    const w = writer;
    w.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  function sendToolResult(params: { requestId: string; resultJson?: string; error?: string }): void {
    request(METHODS.pluginToolResult, params).catch(() => {
      /* socket may already be gone (reconnect in flight) — the invoke times out core-side. */
    });
  }

  /** `PluginContext.hardware` — see that interface's doc comment for the full contract. Uses the
   *  SAME `request()` seam every other outbound RPC in this file uses, so it automatically gets
   *  "not connected" rejection, the 10s default timeout, and reconnect-safe pending-map cleanup
   *  for free; nothing hardware-specific needed there. */
  async function hardwareRequest(verb: string, args?: unknown): Promise<unknown> {
    const result = (await request(METHODS.hardwareRequest, {
      verb, argsJson: JSON.stringify(args ?? {}),
    })) as HardwareRequestWireResult;
    if ("resultJson" in result) return JSON.parse(result.resultJson);
    const detail = [
      ("missing" in result && result.missing) ? `missing: ${result.missing}` : null,
      ("message" in result && result.message) ? result.message : null,
    ].filter((s): s is string => s !== null);
    throw new Error(
      detail.length > 0
        ? `hardware.request failed: ${result.code} (${detail.join("; ")})`
        : `hardware.request failed: ${result.code}`,
    );
  }

  /** `PluginContext.updateTile` — see that method's doc comment for the full contract. Same
   *  `request()` seam as `hardwareRequest` above; `request()` resolves with the RPC `result`
   *  (`{ok: true}` for `tile.update`, mirroring `def.tile`'s once-at-connect push a few lines
   *  below in `connectOnce`) which this discards, resolving `Promise<void>` instead — a plugin
   *  author pushing a live tile cares that the push completed, not the ack's shape. */
  async function updateTile(tile: Record<string, unknown>): Promise<void> {
    await request(METHODS.tileUpdate, { tile });
  }

  const ctx: PluginContext = { hardware: hardwareRequest, updateTile };

  async function handleInvoke(ev: { requestId: string; tool: string; argsJson: string }): Promise<void> {
    const toolDef = def.tools?.[ev.tool];
    if (!toolDef) {
      sendToolResult({ requestId: ev.requestId, error: `unknown tool: ${ev.tool}` });
      return;
    }
    try {
      const args: unknown = JSON.parse(ev.argsJson);
      const result = await toolDef.run(args, ctx);
      sendToolResult({ requestId: ev.requestId, resultJson: JSON.stringify(result === undefined ? null : result) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendToolResult({ requestId: ev.requestId, error: message });
    }
  }

  /** One full connect → hello → register-everything cycle. Rerun verbatim on every reconnect
   *  (spec: "on reconnect redo hello+register-everything — core restart resilience"), so there is
   *  exactly one registration code path for both the first connect and every later one. */
  async function connectOnce(): Promise<void> {
    decoder = new LineDecoder();
    const sock = await Bun.connect({
      unix: socketPath!,
      socket: {
        data(s, chunk) {
          let lines: string[];
          try {
            lines = decoder.push(chunk);
          } catch {
            s.end();
            return;
          }
          for (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
              const p = pending.get(msg.id)!;
              pending.delete(msg.id);
              if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
              else p.resolve(msg.result);
            } else if (msg.method === METHODS.event && msg.params?.type === "plugin_tool_invoke") {
              handleInvoke(msg.params).catch(() => {});
            } else if (msg.method === METHODS.event && msg.params?.type === "shortcut_invoke") {
              // Fire-and-forget (Phase 4d-i Task 3): no plugin.toolResult-style reply for this
              // event, unlike plugin_tool_invoke above — core doesn't wait on it.
              def.onShortcut?.(msg.params.shortcutId, ctx);
            } else if (msg.method === METHODS.event && msg.params?.type === "tile_action") {
              // Fire-and-forget, same posture as shortcut_invoke above.
              def.onTileAction?.(msg.params.actionId, ctx);
            }
            // every other event type (or notification) is skipped.
          }
        },
        drain() {
          writer?.onDrain();
        },
        close() {
          // Final-review Fix B1 (stale-callback guard): `sock` is THIS connectOnce() call's own
          // socket, captured by closure. If it's no longer the one `socket` currently tracks — a
          // newer connectOnce() already took over, most likely because attemptConnect's catch
          // below already end()'d this exact socket in its failure-path cleanup and this is that
          // end() completing asynchronously afterward — resetting shared state / scheduling
          // another reconnect here would be wrong (it could clobber a newer, live connection's
          // state, or double-arm a reconnect for a cycle that's already moved on).
          if (socket !== sock) return;
          writer = null;
          socket = null;
          for (const p of pending.values()) p.reject(new Error("connection closed"));
          pending.clear();
          if (!closed) scheduleReconnect();
        },
        error() {}, // close() always follows and rejects pending — stub silences Bun's stderr print
      },
    });
    socket = sock;
    writer = new ConnWriter(sock as unknown as WritableSocket);

    try {
      await request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION,
        role: "plugin",
        token,
        pluginId,
        clientName: `plugin:${pluginId}`,
      });
    } catch (err) {
      if (isUnauthorizedRpcError(err)) throw new FatalAuthError((err as Error).message);
      throw err;
    }
    await request(METHODS.pluginRegister, { pluginId });
    for (const [name, toolDef] of Object.entries(def.tools ?? {})) {
      await request(METHODS.toolRegister, {
        name, description: toolDef.description, parameters: toolDef.parameters,
      });
    }
    if (def.onShortcut) {
      const shortcuts = readDeclaredShortcuts();
      if (shortcuts.length > 0) await request(METHODS.shortcutRegister, { shortcuts });
    }
    if (def.tile) {
      await request(METHODS.tileUpdate, { tile: def.tile() });
    }

    reconnectAttempt = 0;
  }

  function scheduleReconnect(): void {
    if (closed) return;
    // Final-review Fix B1 (idempotent): a single disconnect can trigger scheduleReconnect from
    // TWO independent places in the same tick — the socket's own `close()` callback above, AND
    // `attemptConnect`'s `.catch` below (when the in-flight `request()` a hello/register was
    // awaiting gets rejected BY that same close() callback, connectOnce()'s promise rejects too).
    // Without this guard the second call would overwrite `reconnectTimer` without clearing the
    // first, leaking an uncleared timer that fires a SECOND, fully independent reconnect cycle
    // later — two concurrent connections sharing this closure's mutable state (decoder/pending/
    // writer), corrupting both. Already-armed means already-handled: no-op.
    if (reconnectTimer !== null) return;
    const delay = backoffDelayMs(reconnectAttempt);
    reconnectAttempt++;
    // Deliberately NOT unref'd: staying connected (or reconnecting) IS this process's entire
    // purpose while `serve()` is active. An idle plugin between calls has no other open handle
    // once its connection drops — an unref'd timer here would let the event loop see "nothing
    // left to do" and exit the process immediately, before the timer ever gets a chance to fire,
    // defeating the "core restart resilience" this reconnect loop exists for (empirically
    // confirmed: a bare unref'd setTimeout as the only handle left in a Bun/Node process does not
    // block exit — the process exits right away instead of waiting out the delay).
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attemptConnect();
    }, delay);
  }

  function attemptConnect(): void {
    connectOnce()
      .then(() => {
        firstConnectResolve?.();
        firstConnectResolve = null;
      })
      .catch((err) => {
        if (err instanceof FatalAuthError) {
          // A rotated/revoked token: this incarnation is permanently superseded. `close()` does
          // the full teardown (clears the reconnect timer, removes signal handlers, ends the
          // socket) — reuse it rather than duplicating that cleanup, then exit instead of
          // reconnecting.
          close();
          process.exit(1);
          return;
        }
        // Final-review Fix B1 (leak-proof): a failure during hello/register can leave the socket
        // genuinely still open — e.g. a business-logic rejection like "duplicate tool" never
        // tears down the TCP/unix connection itself, only the socket's own `close()` callback
        // (which didn't fire) would have nulled out `socket`/`writer`. end() it here so a failed
        // cycle never leaks an authenticated connection the server counts against its connection
        // cap forever. A no-op if `close()` already ran for real (socket already null).
        const leaked = socket;
        socket = null;
        writer = null;
        try { leaked?.end(); } catch { /* already gone */ }
        scheduleReconnect();
      });
  }

  function installSignalHandlers(): void {
    if (sigtermHandler) return; // already installed by a previous serve() call on this instance
    sigtermHandler = () => { close(); process.exit(0); };
    sigintHandler = () => { close(); process.exit(0); };
    process.on("SIGTERM", sigtermHandler);
    process.on("SIGINT", sigintHandler);
  }

  function removeSignalHandlers(): void {
    if (sigtermHandler) { process.off("SIGTERM", sigtermHandler); sigtermHandler = null; }
    if (sigintHandler) { process.off("SIGINT", sigintHandler); sigintHandler = null; }
  }

  function serve(opts?: ServeOptions): Promise<void> {
    if (serving) {
      return Promise.reject(new Error("createPlugin().serve(): already serving"));
    }

    socketPath = opts?.socketPath ?? process.env.WINTER_SOCKET;
    token = opts?.token ?? process.env.WINTER_PLUGIN_TOKEN;
    pluginId = opts?.pluginId ?? process.env.WINTER_PLUGIN_ID;

    const missing: string[] = [];
    if (!socketPath) missing.push("socketPath (WINTER_SOCKET)");
    if (!token) missing.push("token (WINTER_PLUGIN_TOKEN)");
    if (!pluginId) missing.push("pluginId (WINTER_PLUGIN_ID)");
    if (missing.length > 0) {
      return Promise.reject(new Error(`createPlugin().serve(): missing ${missing.join(", ")}`));
    }

    serving = true;
    closed = false;
    installSignalHandlers();

    return new Promise((resolve) => {
      firstConnectResolve = resolve;
      attemptConnect();
    });
  }

  function close(): void {
    closed = true;
    serving = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    removeSignalHandlers();
    const s = socket;
    socket = null;
    writer = null;
    for (const p of pending.values()) p.reject(new Error("connection closed"));
    pending.clear();
    try { s?.end(); } catch { /* already gone */ }
  }

  return { serve, close };
}
