import { createPlugin } from "@yanlinglabs/winter-plugin-sdk";

/**
 * sample-echo — the reference Tier-2 (`platform`) plugin (Phase 4b Task 6, design spec §3/§4).
 * `createPlugin({tools, tile, onShortcut, onTileAction}).serve()` (from `@yanlinglabs/winter-plugin-sdk`) owns
 * the ENTIRE lifecycle contract — connect, hello, register, dispatch, reconnect-with-backoff,
 * clean SIGTERM/SIGINT shutdown — so everything below is purely this plugin's own behavior,
 * nothing wire-level.
 *
 * Two tools:
 *  - `echo {text}` -> `{echo: text, pluginPid: process.pid}`: proves a real round trip through
 *    the supervisor's tool.invoke bridge, and identifies WHICH OS process answered (used by
 *    packages/core/test/plugins/supervised-e2e.test.ts to confirm the reply came from the real
 *    spawned child, not a stub).
 *  - `sleep {ms}` -> `{slept: ms}` after an ACTUAL delay (not instant): Phase 4b Task 7's gate
 *    `kill -9`s this plugin mid-call to exercise the supervisor's crash-during-invoke typed-error
 *    + backoff-restart path — a synchronous tool would resolve before the kill ever lands.
 *
 * Phase 4d-i Task 5: this is the gate's exercised subject for the live-tile pipeline
 * (`packages/core/test/plugins/gate-4d-i.test.ts`). `n` is plain module state — the tile's own
 * counter. `tile()` still paints the ONE-TIME initial value right after every (re)registration
 * (unchanged contract, plugin-sdk's `PluginDefinition.tile` doc comment); `echo`'s `run` ALSO
 * pushes a live `ctx.updateTile` mid-session, proving that path is a genuine "any time after
 * connect" push, not just a once-at-connect paint.
 *
 * `onShortcut`/`onTileAction` need `ctx.updateTile` too, and the SDK now passes it directly: both
 * callbacks receive `(id, ctx)` (plugin-sdk/src/index.ts's `PluginDefinition`, fix wave 1) — the
 * same fixed-shape `ctx` object every tool's `run(args, ctx)` gets, dispatched fresh from
 * `createPlugin`'s closure rather than requiring a plugin to stash one from a prior tool call.
 * That means a shortcut/tile-action fired BEFORE any tool call still works.
 */
let n = 0;

function echoTile(): Record<string, unknown> {
  return { title: "echo", value: String(n), actions: [{ id: "reset", label: "Reset" }] };
}

const plugin = createPlugin({
  tools: {
    echo: {
      description: "Echoes `text` back, tagged with this plugin process's OS pid. Also bumps the live echo tile.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      run: async (args, ctx) => {
        const { text } = args as { text: string };
        n++;
        await ctx.updateTile(echoTile());
        return { echo: text, pluginPid: process.pid };
      },
    },
    sleep: {
      description: "Waits `ms` milliseconds (a real delay, not instant) then resolves with `{slept: ms}`.",
      parameters: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"],
      },
      run: async (args) => {
        const { ms } = args as { ms: number };
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { slept: ms };
      },
    },
  },
  tile: echoTile,
  // Fire-and-forget (no reply — see the module doc comment above): bumps the same counter
  // `echo` does, then pushes the fresh tile through the ctx the SDK hands directly.
  onShortcut: (_id, ctx) => {
    n++;
    void ctx.updateTile(echoTile());
  },
  // Fire-and-forget, same posture as onShortcut above: resets the counter back to 0.
  onTileAction: (_id, ctx) => {
    n = 0;
    void ctx.updateTile(echoTile());
  },
});

plugin.serve().catch((err) => {
  console.error(`sample-echo: failed to start: ${(err as Error).message}`);
  process.exit(1);
});
