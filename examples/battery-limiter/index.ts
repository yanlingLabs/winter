import { createPlugin } from "@winter/plugin-sdk";

/**
 * battery-limiter — the reference Tier-2 (`platform`) plugin for `ctx.hardware()` (Phase 4c Task 5,
 * design spec §5). Every hardware access below goes through `ctx.hardware(verb, args)` — the SDK's
 * thin wrapper around core's `hardware.request` JSON-RPC method, which core then brokers to
 * Winter.app's privileged XPC helper (WinterHelper, Task 3) via a `hardware_requested` push to the
 * active provider connection. This plugin never talks to the helper directly and never needs to —
 * that's the entire point of `ctx.hardware` existing.
 *
 * Two tools, both consent-gated on the "battery" hardware class (`winter-plugin.json`'s
 * `permissions.hardware: ["battery"]`):
 *  - `set_charge_limit {percent}` -> `ctx.hardware("setChargeLimit", {percent})`
 *  - `get_charge_limit {}` -> `ctx.hardware("getChargeLimit")`
 *
 * Both calls THROW on any typed hardware failure (unknown_verb/consent_denied/no_provider/timeout/
 * provider_error — see `@winter/plugin-sdk`'s `PluginContext.hardware` doc comment) rather than
 * returning an error-shaped value, so a failure naturally becomes a typed `plugin.toolResult
 * {error}` — no try/catch needed here, same "let it throw" posture as sample-echo's `boom` tool.
 *
 * `lastKnownLimit` is plain in-process module state (nothing persisted). `tile()` still paints
 * exactly ONE `tile.update` per registration cycle (`createPlugin(...).serve()` — see its doc
 * comment: "after EVERY reconnect") — a fresh process (or one that's never successfully called
 * either tool yet) reports "unknown" at connect time, not a stale/guessed value.
 *
 * Phase 4d-i Task 5 (closes the 4b "battery-limiter tile shows unknown" bug): that once-at-connect
 * paint used to be the ONLY tile push this plugin ever made — set_charge_limit could update
 * `lastKnownLimit` all it wanted, but nothing ever told a live dashboard, so the tile stayed
 * "unknown" (or whatever it showed at connect) for the plugin's entire connection lifetime. Both
 * tools below now ALSO call `ctx.updateTile` after they run, using the SAME `currentValue()`
 * formatting `tile()` uses, so a dashboard sees the real value the moment either tool call
 * resolves — proven end to end (real spawned child, no scripted stand-in beyond the hardware
 * provider boundary) by `packages/core/test/plugins/battery-limiter-e2e.test.ts`.
 */
let lastKnownLimit: number | undefined;

function extractPercent(result: unknown): number | undefined {
  if (result && typeof result === "object" && "percent" in result) {
    const p = (result as { percent: unknown }).percent;
    if (typeof p === "number") return p;
  }
  return undefined;
}

/** Shared by `tile()`'s initial paint and both tools' live `ctx.updateTile` push below — "off"
 *  reads better than "100%" for a disabled/uncapped limit (brief: "the limit percent, or \"off\"
 *  when 100/disabled"), everything else is `<percent>%`, and an as-yet-unobserved limit is
 *  "unknown", same as before this task. */
function currentValue(): string {
  if (lastKnownLimit === undefined) return "unknown";
  return lastKnownLimit >= 100 ? "off" : `${lastKnownLimit}%`;
}

const plugin = createPlugin({
  tools: {
    set_charge_limit: {
      description: "Sets the battery charge limit (percent, 1-100) via Winter.app's XPC helper.",
      parameters: {
        type: "object",
        properties: { percent: { type: "number" } },
        required: ["percent"],
      },
      run: async (args, ctx) => {
        const { percent } = args as { percent: number };
        const result = await ctx.hardware("setChargeLimit", { percent });
        // The provider's own reply is the source of truth when it echoes back a `percent`
        // (confirms what actually got set); fall back to the requested value otherwise.
        lastKnownLimit = extractPercent(result) ?? percent;
        // Phase 4d-i Task 5: live push so a dashboard reflects the new limit immediately, not just
        // at this plugin's next reconnect — see the module doc comment above.
        await ctx.updateTile({ title: "Battery Limiter", value: currentValue() });
        return result;
      },
    },
    get_charge_limit: {
      description: "Reads the current battery charge limit via Winter.app's XPC helper.",
      parameters: { type: "object", properties: {} },
      run: async (_args, ctx) => {
        const result = await ctx.hardware("getChargeLimit");
        const observed = extractPercent(result);
        if (observed !== undefined) lastKnownLimit = observed;
        // Phase 4d-i Task 5: live push, same as set_charge_limit above — reflects whatever is
        // currently known even when `observed` came back undefined (a malformed provider reply
        // never regresses the tile to something worse than the last live push already showed).
        await ctx.updateTile({ title: "Battery Limiter", value: currentValue() });
        return result;
      },
    },
  },
  tile: () => ({
    title: "Battery Limiter",
    value: currentValue(),
  }),
});

plugin.serve().catch((err) => {
  console.error(`battery-limiter: failed to start: ${(err as Error).message}`);
  process.exit(1);
});
