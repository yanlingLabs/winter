import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, LineDecoder, METHODS, PROTOCOL_VERSION, ERR } from "@winter/protocol";
import { backoffDelayMs, createPlugin } from "../src/index";

// -------------------------------------------------------------------------------------------
// Scripted in-process server fixture (mirrors packages/cli/test/client.test.ts's "hostile/fake
// server" pattern and packages/core/src/ipc/server.ts's Bun.listen<ConnState> shape) — just
// enough of the plugin-role wire protocol to drive `createPlugin().serve()` through a full
// handshake, dispatch a `plugin_tool_invoke` push, and support a stop/restart cycle for the
// reconnect test.
// -------------------------------------------------------------------------------------------

interface ConnState { decoder: LineDecoder }

interface ToolResultParams { requestId: string; resultJson?: string; error?: string }
interface ShortcutEntry { id: string; description?: string; default?: string }

interface HardwareRequestRecord { verb: string; argsJson?: string }

interface FakeServer {
  order: string[];
  registeredTools: string[];
  shortcuts(): ShortcutEntry[] | null;
  tiles: Array<Record<string, unknown>>;
  toolResults: ToolResultParams[];
  hardwareRequests: HardwareRequestRecord[];
  connectionCount(): number;
  /** High-water mark of CONCURRENTLY open connections (final-review Fix B1) — distinct from
   *  `connectionCount()`'s running total: a legitimate reconnect cycle (old socket fully closed,
   *  THEN a new one opens) grows the total without ever exceeding 1 live at a time. A double-armed
   *  reconnect loop (the bug B1 fixes) briefly holds TWO live sockets at once, which this catches
   *  and `connectionCount()` alone cannot. */
  peakConcurrentConnections(): number;
  pushEvent(params: unknown): void;
  stop(): void;
}

/** Controls how the fake server answers `hello`, for exercising the two disconnect-during-
 *  handshake / fatal-auth scenarios (final-review Fix B1) the happy-path tests above don't touch. */
type HelloMode =
  | { kind: "ok" }
  /** The FIRST connection's hello is received but never answered — the socket is torn down
   *  instead, simulating "disconnect while a handshake request is in flight". Every later
   *  connection (a reconnect) gets a normal ok response. */
  | { kind: "drop-first" }
  /** Every hello is answered with a JSON-RPC error at ERR.UNAUTHORIZED — simulates a rotated/
   *  revoked token. */
  | { kind: "unauthorized" };

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* nothing to remove */ }
}

/** `hardwareHandler`, when given, is consulted for every `hardware.request` the fake server
 *  receives and its return value is written back verbatim as the JSON-RPC `result` (the SDK-side
 *  `ctx.hardware()` under test never sees these as an `msg.error` — Task 2's `HardwareRequestResult`
 *  is a RESOLVED result union, success and every typed failure alike; see methods.ts). Omitted ->
 *  every hardware.request gets `{code: "unknown_verb"}` (not exercised by tests that don't pass it). */
function startFakeServer(
  path: string,
  helloMode: HelloMode = { kind: "ok" },
  hardwareHandler?: (params: HardwareRequestRecord) => unknown,
): FakeServer {
  safeUnlink(path); // a prior listener's socket file may still be on disk (restart tests)

  const order: string[] = [];
  const registeredTools: string[] = [];
  let shortcuts: ShortcutEntry[] | null = null;
  const tiles: Array<Record<string, unknown>> = [];
  const toolResults: ToolResultParams[] = [];
  const hardwareRequests: HardwareRequestRecord[] = [];
  let connections = 0;
  let liveNow = 0;
  let peakLive = 0;
  let active: Bun.Socket<ConnState> | null = null;

  const server = Bun.listen<ConnState>({
    unix: path,
    socket: {
      open(socket) {
        connections++;
        liveNow++;
        peakLive = Math.max(peakLive, liveNow);
        active = socket;
        socket.data = { decoder: new LineDecoder() };
      },
      data(socket, chunk) {
        for (const line of socket.data.decoder.push(chunk)) {
          const msg = JSON.parse(line);
          switch (msg.method) {
            case METHODS.hello:
              order.push(METHODS.hello);
              if (helloMode.kind === "drop-first" && connections === 1) {
                socket.end(); // never respond — simulates a disconnect mid-handshake
                break;
              }
              if (helloMode.kind === "unauthorized") {
                socket.write(encodeLine({
                  jsonrpc: "2.0", id: msg.id,
                  error: { code: ERR.UNAUTHORIZED, message: "invalid token for role" },
                }));
                break;
              }
              socket.write(encodeLine({
                jsonrpc: "2.0", id: msg.id,
                result: { ok: true, serverVersion: "fake", protocolVersion: PROTOCOL_VERSION },
              }));
              break;
            case METHODS.pluginRegister:
              order.push(METHODS.pluginRegister);
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            case METHODS.toolRegister:
              order.push(METHODS.toolRegister);
              registeredTools.push(msg.params.name);
              socket.write(encodeLine({
                jsonrpc: "2.0", id: msg.id,
                result: { ok: true, registeredAs: `plugin__test__${msg.params.name}` },
              }));
              break;
            case METHODS.shortcutRegister:
              order.push(METHODS.shortcutRegister);
              shortcuts = msg.params.shortcuts;
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            case METHODS.tileUpdate:
              order.push(METHODS.tileUpdate);
              tiles.push(msg.params.tile);
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            case METHODS.pluginToolResult:
              toolResults.push(msg.params);
              socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
              break;
            case METHODS.hardwareRequest:
              hardwareRequests.push(msg.params);
              socket.write(encodeLine({
                jsonrpc: "2.0", id: msg.id,
                result: hardwareHandler ? hardwareHandler(msg.params) : { code: "unknown_verb" },
              }));
              break;
            default:
              // never answered — not exercised by these tests
              break;
          }
        }
      },
      close(socket) {
        liveNow--;
        if (active === socket) active = null;
      },
    },
  });

  return {
    order, registeredTools, tiles, toolResults, hardwareRequests,
    shortcuts: () => shortcuts,
    connectionCount: () => connections,
    peakConcurrentConnections: () => peakLive,
    pushEvent(params: unknown) {
      active?.write(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params }));
    },
    stop() { server.stop(true); },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// -------------------------------------------------------------------------------------------

describe("createPlugin().serve()", () => {
  let cleanups: Array<() => void>;
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    cleanups = [];
    tmpDir = mkdtempSync(join(tmpdir(), "winter-plugin-sdk-"));
    sockPath = join(tmpDir, "plugin.sock");
  });
  afterEach(() => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* best-effort teardown */ }
    }
  });

  test("handshake order (hello -> plugin.register -> tool.register x N) and tile push after registration", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({
      tools: {
        alpha: { description: "first tool", run: () => "a" },
        beta: { description: "second tool", run: () => "b" },
      },
      tile: () => ({ title: "Sample", value: 42 }),
    });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).toEqual([
      METHODS.hello, METHODS.pluginRegister, METHODS.toolRegister, METHODS.toolRegister, METHODS.tileUpdate,
    ]);
    expect(server.registeredTools).toEqual(["alpha", "beta"]);
    expect(server.tiles).toEqual([{ title: "Sample", value: 42 }]);
  });

  test("invoke dispatch: sync handler, async handler, throwing handler, unknown tool", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({
      tools: {
        echo: { description: "echo", run: (args) => ({ echoed: (args as { text: string }).text }) },
        addAsync: {
          description: "add",
          run: async (args) => {
            await new Promise((r) => setTimeout(r, 5));
            const a = args as { a: number; b: number };
            return a.a + a.b;
          },
        },
        boom: { description: "throws", run: () => { throw new Error("kaboom"); } },
      },
    });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r1", tool: "echo", argsJson: JSON.stringify({ text: "hi" }) });
    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r2", tool: "addAsync", argsJson: JSON.stringify({ a: 2, b: 3 }) });
    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r3", tool: "boom", argsJson: "{}" });
    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r4", tool: "missing", argsJson: "{}" });

    await waitFor(() => server.toolResults.length >= 4);

    const byId = Object.fromEntries(server.toolResults.map((r) => [r.requestId, r]));
    expect(JSON.parse(byId.r1!.resultJson!)).toEqual({ echoed: "hi" });
    expect(JSON.parse(byId.r2!.resultJson!)).toEqual(5);
    expect(byId.r3!.error).toBe("kaboom");
    expect(byId.r3!.resultJson).toBeUndefined();
    expect(byId.r4!.error).toBe("unknown tool: missing");
  });

  test("reconnect: server restart triggers a full re-registration handshake", async () => {
    let server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: { ping: { description: "ping", run: () => "pong" } } });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });
    expect(server.order).toEqual([METHODS.hello, METHODS.pluginRegister, METHODS.toolRegister]);

    server.stop();
    safeUnlink(sockPath);

    const server2 = startFakeServer(sockPath);
    cleanups.push(() => server2.stop());

    // base reconnect delay is 1s (backoffDelayMs(0) === 1000) — give it real headroom.
    await waitFor(() => server2.order.length >= 3, 6000);
    expect(server2.order).toEqual([METHODS.hello, METHODS.pluginRegister, METHODS.toolRegister]);
  }, 10_000);

  test("close() stops reconnecting", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: {} });
    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });
    expect(server.connectionCount()).toBe(1);

    plugin.close();
    server.stop();
    safeUnlink(sockPath);

    const server2 = startFakeServer(sockPath);
    cleanups.push(() => server2.stop());

    await new Promise((r) => setTimeout(r, 1800)); // longer than the 1s base backoff
    expect(server2.connectionCount()).toBe(0);
  }, 5000);

  // Final-review Fix B1: a disconnect while `hello`'s response is still in flight used to arm TWO
  // independent reconnect loops (the socket's own close() callback, AND connectOnce()'s rejected
  // `await request(hello...)` propagating up through attemptConnect's own `.catch`) — the loser
  // loop shared this instance's mutable decoder/pending/writer state with the winner, corrupting
  // both, and leaked whichever socket its own failure path never end()'d.
  test("disconnect during in-flight hello -> exactly ONE reconnect loop, no leaked/overlapping socket", async () => {
    const server = startFakeServer(sockPath, { kind: "drop-first" });
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: { ping: { description: "ping", run: () => "pong" } } });
    cleanups.push(() => plugin.close());

    // The first connection's hello is dropped (no response, socket torn down) — serve() only
    // resolves once a LATER reconnect completes the full handshake for real.
    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });
    expect(server.order).toEqual([METHODS.hello, METHODS.hello, METHODS.pluginRegister, METHODS.toolRegister]);

    // Exactly 2 connections total (1 aborted + 1 successful) — a double-armed reconnect loop would
    // eventually produce a 3rd (the leaked loop's own independent retry). Give it a beat past the
    // base 1s backoff to prove no further connection shows up.
    await new Promise((r) => setTimeout(r, 1500));
    expect(server.connectionCount()).toBe(2);
    // Never more than 1 socket open at once — no overlapping/leaked connection at any point.
    expect(server.peakConcurrentConnections()).toBe(1);
  }, 10_000);

  test("hello UNAUTHORIZED is fatal: exits without scheduling a reconnect", async () => {
    const server = startFakeServer(sockPath, { kind: "unauthorized" });
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: {} });
    cleanups.push(() => plugin.close());

    let exitCode: number | undefined;
    const originalExit = process.exit;
    // Swallow process.exit — real usage kills the process, but that can't happen inside the test
    // runner. `attemptConnect`'s fatal branch does `close(); process.exit(1); return;` in that
    // order, so cleanup already ran by the time this fires; a real exit would just never come back
    // here, which is what the plain `return` after the call already assumes.
    process.exit = ((code?: number) => { exitCode = code; }) as unknown as typeof process.exit;
    cleanups.push(() => { process.exit = originalExit; });

    void plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" }); // never resolves — the fatal path never calls firstConnectResolve

    await waitFor(() => exitCode !== undefined, 2000);
    expect(exitCode).toBe(1);
    expect(server.order).toEqual([METHODS.hello]);

    // No reconnect scheduled: wait past the base 1s backoff and confirm no second attempt.
    const before = server.connectionCount();
    await new Promise((r) => setTimeout(r, 1500));
    expect(server.connectionCount()).toBe(before);
  }, 5000);

  test("serve() installs SIGTERM/SIGINT handlers; close() removes them", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: {} });
    const beforeTerm = process.listeners("SIGTERM").length;
    const beforeInt = process.listeners("SIGINT").length;

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(process.listeners("SIGTERM").length).toBe(beforeTerm + 1);
    expect(process.listeners("SIGINT").length).toBe(beforeInt + 1);

    plugin.close();

    expect(process.listeners("SIGTERM").length).toBe(beforeTerm);
    expect(process.listeners("SIGINT").length).toBe(beforeInt);
  });

  test("serve() rejects when socketPath/token/pluginId cannot be resolved (no opts, no env)", async () => {
    const savedSocket = process.env.WINTER_SOCKET;
    const savedToken = process.env.WINTER_PLUGIN_TOKEN;
    const savedId = process.env.WINTER_PLUGIN_ID;
    delete process.env.WINTER_SOCKET;
    delete process.env.WINTER_PLUGIN_TOKEN;
    delete process.env.WINTER_PLUGIN_ID;
    cleanups.push(() => {
      if (savedSocket !== undefined) process.env.WINTER_SOCKET = savedSocket;
      if (savedToken !== undefined) process.env.WINTER_PLUGIN_TOKEN = savedToken;
      if (savedId !== undefined) process.env.WINTER_PLUGIN_ID = savedId;
    });

    const plugin = createPlugin({});
    await expect(plugin.serve({})).rejects.toThrow(/missing/);
  });

  test("onShortcut: registers the shortcut ids declared in winter-plugin.json (plugin cwd)", async () => {
    writeFileSync(join(tmpDir, "winter-plugin.json"), JSON.stringify({
      id: "sample", tier: "platform",
      contributes: { shortcuts: [{ id: "toggle", description: "Toggle the thing" }] },
    }));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    cleanups.push(() => process.chdir(originalCwd));

    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ onShortcut: () => {} });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).toContain(METHODS.shortcutRegister);
    expect(server.shortcuts()).toEqual([{ id: "toggle", description: "Toggle the thing" }]);
  });

  test("onShortcut with no manifest present never calls shortcut.register", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmpDir); // empty tmp dir — no winter-plugin.json
    cleanups.push(() => process.chdir(originalCwd));

    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ onShortcut: () => {} });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).not.toContain(METHODS.shortcutRegister);
    expect(server.shortcuts()).toBeNull();
  });

  test("WINTER_PLUGIN_DIR env var: manifest read from env var, not cwd, when set", async () => {
    // Create manifest in a separate directory
    const pluginDir = mkdtempSync(join(tmpdir(), "winter-plugin-env-"));
    cleanups.push(() => {
      try { unlinkSync(join(pluginDir, "winter-plugin.json")); } catch {}
    });
    writeFileSync(join(pluginDir, "winter-plugin.json"), JSON.stringify({
      id: "sample", tier: "platform",
      contributes: { shortcuts: [{ id: "cmd-a", description: "Command A" }, { id: "cmd-b" }] },
    }));

    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ onShortcut: () => {} });
    cleanups.push(() => plugin.close());

    // Serve with WINTER_PLUGIN_DIR pointing to the manifest, while cwd is tmpDir (which is empty)
    const savedEnv = process.env.WINTER_PLUGIN_DIR;
    process.env.WINTER_PLUGIN_DIR = pluginDir;
    cleanups.push(() => {
      if (savedEnv !== undefined) process.env.WINTER_PLUGIN_DIR = savedEnv;
      else delete process.env.WINTER_PLUGIN_DIR;
    });

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    expect(server.order).toContain(METHODS.shortcutRegister);
    expect(server.shortcuts()).toEqual([
      { id: "cmd-a", description: "Command A" },
      { id: "cmd-b" },
    ]);
  });

  test("double serve() rejects with clear error", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({ tools: {} });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    await expect(plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" }))
      .rejects.toThrow(/already serving/);
  });
});

// -------------------------------------------------------------------------------------------
// ctx.hardware (Phase 4c Task 5, spec §5) — `run(args, ctx)`'s second arg. Every case here drives
// a real tool `run` handler through the SAME `plugin_tool_invoke` -> `plugin.toolResult` dispatch
// path the tests above exercise, so a throw from `ctx.hardware()` is proven to surface exactly the
// way any other thrown error in a handler already does (`handleInvoke`'s catch), not asserted
// against `ctx.hardware()` in isolation. `startFakeServer`'s `hardwareHandler` answers
// `hardware.request` with a SCRIPTED RESULT (msg.result, never msg.error) — Task 2's
// `HardwareRequestResult` (methods.ts) is a resolved union for success AND every typed failure
// alike, so `{code:"timeout"}` here is a scripted reply, deliberately never the SDK's own 10s
// transport-level `request()` timeout (a completely different failure mode, already covered by
// this file's reconnect/hello tests).
// -------------------------------------------------------------------------------------------

describe("ctx.hardware (Phase 4c Task 5, spec §5)", () => {
  let cleanups: Array<() => void>;
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    cleanups = [];
    tmpDir = mkdtempSync(join(tmpdir(), "winter-plugin-sdk-hw-"));
    sockPath = join(tmpDir, "plugin.sock");
  });
  afterEach(() => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* best-effort teardown */ }
    }
  });

  /** Boots a plugin with a single tool, `call`, whose `run` invokes `ctx.hardware(verb, args)` and
   *  either returns its resolved value or lets a thrown error propagate — i.e. exactly what a real
   *  tool author writes, nothing test-specific in the handler itself. */
  async function bootCallTool(
    hardwareHandler: (params: HardwareRequestRecord) => unknown,
  ): Promise<{ server: FakeServer; plugin: ReturnType<typeof createPlugin>; invoke: (verb: string, args?: unknown) => Promise<ToolResultParams> }> {
    const server = startFakeServer(sockPath, { kind: "ok" }, hardwareHandler);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({
      tools: {
        call: {
          description: "calls ctx.hardware with whatever the test asks",
          run: async (args, ctx) => {
            const { verb, hwArgs } = args as { verb: string; hwArgs?: unknown };
            return ctx.hardware(verb, hwArgs);
          },
        },
      },
    });
    cleanups.push(() => plugin.close());
    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    let seq = 0;
    return {
      server, plugin,
      async invoke(verb: string, hwArgs?: unknown): Promise<ToolResultParams> {
        const requestId = `r${++seq}`;
        server.pushEvent({ type: "plugin_tool_invoke", requestId, tool: "call", argsJson: JSON.stringify({ verb, hwArgs }) });
        await waitFor(() => server.toolResults.some((r) => r.requestId === requestId));
        return server.toolResults.find((r) => r.requestId === requestId)!;
      },
    };
  }

  test("success: sends {verb, argsJson} and resolves with JSON.parse(resultJson)", async () => {
    const { server, invoke } = await bootCallTool((params) => {
      expect(params.verb).toBe("setChargeLimit");
      expect(params.argsJson).toBe(JSON.stringify({ percent: 80 }));
      return { resultJson: JSON.stringify({ percent: 80 }) };
    });

    const res = await invoke("setChargeLimit", { percent: 80 });
    expect(res.error).toBeUndefined();
    expect(JSON.parse(res.resultJson!)).toEqual({ percent: 80 });
    expect(server.hardwareRequests).toEqual([{ verb: "setChargeLimit", argsJson: JSON.stringify({ percent: 80 }) }]);
  });

  test("success with no args: argsJson defaults to \"{}\" (never left undefined)", async () => {
    const { server, invoke } = await bootCallTool((params) => {
      expect(params.argsJson).toBe("{}");
      return { resultJson: JSON.stringify({ percent: 42 }) };
    });

    const res = await invoke("getChargeLimit"); // hwArgs omitted
    expect(res.error).toBeUndefined();
    expect(JSON.parse(res.resultJson!)).toEqual({ percent: 42 });
    expect(server.hardwareRequests).toEqual([{ verb: "getChargeLimit", argsJson: "{}" }]);
  });

  test("typed failure: unknown_verb -> throws, tool result carries the code", async () => {
    const { invoke } = await bootCallTool(() => ({ code: "unknown_verb" }));
    const res = await invoke("setFanSpeed");
    expect(res.resultJson).toBeUndefined();
    expect(res.error).toContain("unknown_verb");
  });

  test("typed failure: consent_denied -> throws, tool result carries the code and missing class", async () => {
    const { invoke } = await bootCallTool(() => ({ code: "consent_denied", missing: "hardware" }));
    const res = await invoke("getChargeLimit");
    expect(res.resultJson).toBeUndefined();
    expect(res.error).toContain("consent_denied");
    expect(res.error).toContain("hardware");
  });

  test("typed failure: no_provider -> throws, tool result carries the code and message", async () => {
    const { invoke } = await bootCallTool(() => ({ code: "no_provider", message: "hardware features require Winter.app" }));
    const res = await invoke("getChargeLimit");
    expect(res.resultJson).toBeUndefined();
    expect(res.error).toContain("no_provider");
    expect(res.error).toContain("hardware features require Winter.app");
  });

  test("typed failure: timeout (scripted RESULT, not the SDK's own transport timeout) -> throws, tool result carries the code", async () => {
    const { invoke } = await bootCallTool(() => ({ code: "timeout" }));
    const res = await invoke("getChargeLimit");
    expect(res.resultJson).toBeUndefined();
    expect(res.error).toContain("timeout");
  });

  test("typed failure: provider_error -> throws, tool result carries the code and message", async () => {
    const { invoke } = await bootCallTool(() => ({ code: "provider_error", message: "SMC write failed" }));
    const res = await invoke("setChargeLimit", { percent: 80 });
    expect(res.resultJson).toBeUndefined();
    expect(res.error).toContain("provider_error");
    expect(res.error).toContain("SMC write failed");
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4d-i Task 3: `ctx.updateTile()` live push + `onShortcut`/`onTileAction` dispatch. The
// once-at-connect `tile.update` (from `def.tile`) is already covered by the "handshake order"
// test above; these three tests cover the NEW surface — a mid-session live push via `ctx`, and
// the two fire-and-forget event dispatches Task 2 added to the wire (`shortcut_invoke`,
// `tile_action`) that 4b's dispatch loop never routed anywhere.
// -------------------------------------------------------------------------------------------

describe("Phase 4d-i Task 3: ctx.updateTile + onShortcut/onTileAction dispatch", () => {
  let cleanups: Array<() => void>;
  let tmpDir: string;
  let sockPath: string;

  beforeEach(() => {
    cleanups = [];
    tmpDir = mkdtempSync(join(tmpdir(), "winter-plugin-sdk-4d-"));
    sockPath = join(tmpDir, "plugin.sock");
  });
  afterEach(() => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* best-effort teardown */ }
    }
  });

  test("ctx.updateTile: a tool calling ctx.updateTile() sends a mid-session tile.update", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const plugin = createPlugin({
      tools: {
        push: {
          description: "pushes a live tile",
          run: async (_args, ctx) => {
            await ctx.updateTile({ title: "X", value: "9" });
            return "ok";
          },
        },
      },
    });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });
    // No `def.tile` here, so the only tile.update on the wire is the one the tool triggers.
    expect(server.tiles).toEqual([]);

    server.pushEvent({ type: "plugin_tool_invoke", requestId: "r1", tool: "push", argsJson: "{}" });
    await waitFor(() => server.tiles.length >= 1);

    expect(server.tiles).toEqual([{ title: "X", value: "9" }]);
    await waitFor(() => server.toolResults.some((r) => r.requestId === "r1"));
    const result = server.toolResults.find((r) => r.requestId === "r1")!;
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.resultJson!)).toEqual("ok");
  });

  test("onShortcut: a shortcut_invoke event dispatches to def.onShortcut(shortcutId)", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const received: string[] = [];
    const plugin = createPlugin({ onShortcut: (id) => { received.push(id); } });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    server.pushEvent({ type: "shortcut_invoke", shortcutId: "s1" });

    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["s1"]);
  });

  test("onTileAction: a tile_action event dispatches to def.onTileAction(actionId)", async () => {
    const server = startFakeServer(sockPath);
    cleanups.push(() => server.stop());

    const received: string[] = [];
    const plugin = createPlugin({ onTileAction: (id) => { received.push(id); } });
    cleanups.push(() => plugin.close());

    await plugin.serve({ socketPath: sockPath, token: "tok", pluginId: "sample" });

    server.pushEvent({ type: "tile_action", actionId: "a1" });

    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["a1"]);
  });
});

describe("backoffDelayMs", () => {
  test("1s * 2^n, capped at 30s", () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(5)).toBe(30_000); // 32000 -> capped
    expect(backoffDelayMs(10)).toBe(30_000);
  });
});
