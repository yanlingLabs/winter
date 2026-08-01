import { afterEach, describe, expect, test } from "bun:test";
import { bootSupervisedServer, isPidAlive, waitFor } from "./supervised-fixtures";

/**
 * Phase 4b Task 6 — the sample-echo reference plugin, proven end to end against a REAL `bun
 * index.ts` child process (no scripted/fake connection anywhere in this file — that coverage
 * already exists in server.test.ts's "plugin tool bridge (Task 4)" suite, which injects a fake
 * `spawn` and drives the "plugin" side with a raw `TestClient` socket). This suite boots a real
 * IPC server (mirroring server.test.ts's `bootBridgeServer` construction — direct `ToolRegistry`/
 * `PluginSupervisor`/`PluginContribRegistry` instances, since neither `RunningDaemon` nor
 * `IpcServer` exposes them) and a real `PluginSupervisor` with PRODUCTION spawn/signal deps (all
 * omitted below — only timing knobs are shortened for test speed), pointed at a tmp `normaHome`
 * that has `examples/sample-echo` actually installed, enabled, and exec-consented in
 * `settings.json` — exactly the state `pluginSpawnEligible` (agent/plugins.ts) requires before the
 * real daemon would ever spawn it.
 *
 * The install/settings/boot machinery is shared with Task 7's `gate-4b.test.ts` — see
 * `./supervised-fixtures.ts` for the SDK-import-path rewrite rationale (bare `@norma/plugin-sdk`
 * specifier -> absolute path into `packages/plugin-sdk/src/index.ts`) and the full boot sequence.
 */

describe("supervised e2e: sample-echo (real Bun child process)", () => {
  let srv: Awaited<ReturnType<typeof bootSupervisedServer>> | null = null;

  afterEach(() => { srv?.stop(); srv = null; });

  test(
    "real child registers within the timeout, echo round-trips through registry.execute with the real child's pid, tile lands in the contrib registry, and teardown leaves no orphan process",
    async () => {
      const pluginId = "sample-echo";
      srv = await bootSupervisedServer(pluginId);

      // 1. Registration: the real `bun index.ts` child connects, hellos as role "plugin", and
      // calls plugin.register — the supervisor status flips out of "starting" into "running".
      await waitFor(
        () => srv?.supervisor.status(pluginId) === "running",
        30_000,
        `supervisor status "running" for ${pluginId}`,
      );

      // 2. Tool registration: plugin.register resolving flips supervisor status to "running"
      // BEFORE the child's subsequent tool.register calls (for both `echo` and `sleep`, per
      // examples/sample-echo/index.ts) land — wait for both explicitly rather than assuming they
      // raced ahead of the status flip above.
      await waitFor(
        () => !!(srv?.registry.has(`plugin__${pluginId}__echo`) && srv?.registry.has(`plugin__${pluginId}__sleep`)),
        5_000,
        `plugin__${pluginId}__{echo,sleep} registered`,
      );

      // 3. Tile contribution: examples/sample-echo/index.ts declares `tile: () => ({...})` — the
      // SDK pushes tile.update once, right after registration; poll since it can race the tool
      // registrations above (both fire off the same registration cycle, no ordering guarantee
      // between them). Checked BEFORE the echo round-trip below — Phase 4d-i Task 5: `echo`'s
      // `run` now ALSO pushes a live `ctx.updateTile` (the "battery-limiter tile shows unknown"
      // fix's sibling, proven end to end by gate-4d-i.test.ts), so asserting the tile here first
      // pins down the one-time INITIAL paint deterministically, before that later push could win
      // a wire race against it and flip the value out from under this assertion.
      await waitFor(
        () => srv?.contrib.get(pluginId)?.tile !== undefined,
        2_000,
        `tile.update landed in the contrib registry for ${pluginId}`,
      );
      expect(srv.contrib.get(pluginId)?.tile).toEqual({ title: "echo", value: "0", actions: [{ id: "reset", label: "Reset" }] });

      // 4. Echo round-trip: registry.execute pushes plugin_tool_invoke over the REAL socket to
      // the REAL child, which runs its `echo` handler and answers with plugin.toolResult — the
      // full PluginSupervisor.invoke() correlation path, no fake connection involved.
      const outcome = await srv.registry.execute(
        `plugin__${pluginId}__echo`,
        { text: "hi" },
        { cwd: "/", roots: ["/"], sessionId: "e2e" },
      );
      expect(outcome.isError).toBe(false);
      const parsed = JSON.parse(outcome.output) as { echo: string; pluginPid: number };
      expect(parsed.echo).toBe("hi");
      expect(Number.isInteger(parsed.pluginPid)).toBe(true);
      expect(parsed.pluginPid).toBeGreaterThan(0);
      expect(parsed.pluginPid).not.toBe(process.pid); // really a separate spawned process
      expect(isPidAlive(parsed.pluginPid)).toBe(true);
      const childPid = parsed.pluginPid;

      // 5. Clean teardown: stop() (supervisor.stopAll() + server.stop() + store.close()) SIGTERMs
      // the real child; the SDK's own signal handler closes its socket and calls process.exit(0).
      // No orphan process should survive — verified with a real `ps -p` check, not just "the
      // promise resolved".
      const registry = srv.registry;
      const booted = srv;
      srv = null; // afterEach must not double-stop
      booted.stop();

      await waitFor(() => !isPidAlive(childPid), 5_000, `child pid ${childPid} to exit after stop()`);
      expect(isPidAlive(childPid)).toBe(false);

      // Bonus: the ipc server's own socket-close handler unregisters the plugin's tools
      // independently of the supervisor's own bookkeeping above — confirms teardown is clean on
      // both sides, not just "the process died".
      await waitFor(() => !registry.has(`plugin__${pluginId}__echo`), 2_000, `plugin__${pluginId}__echo unregistered after disconnect`);
    },
    20_000,
  );
});
