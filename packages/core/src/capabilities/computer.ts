// The `computer` capability server (P8b-12) — computer use: `ax_snapshot`, `screenshot`/`zoom`,
// click/drag/type/key/scroll, `wait`.
//
// THREE THINGS THIS FILE DELIBERATELY DOES NOT DO:
//
//  1. It never prompts. The tool drives `ComputerUseService` over `PeripheralBroker`, whose approval
//     cards come from `daemon.ts`'s `buildLeasePolicy` — NOT from the tool, and NOT from the engine.
//     That producer is untouched by 8b, so a lease card raised by a Winter-leg screenshot is the
//     same card a code-mode screenshot raises today. Task 8's `canUseTool` bridge is the other,
//     independent approval surface; nothing here duplicates either.
//  2. It never builds its own `ComputerUseService`. The service holds the session's LEASE state, so
//     a second instance would grant a second lease over the same peripherals. `deps` carries a
//     getter over `daemon.ts`'s single `let computerUse` holder — the same holder the engine's own
//     `computerUse: () => computerUse` getter reads, and the same one `settings-apply.ts` reassigns
//     when the user toggles the feature at runtime.
//  3. It never decides whether computer use is ENABLED. That is `buildCapabilities`' call (the
//     boot-time setting) plus, per session, Task 9's `disallowedTools` — see `index.ts`.
//
// The `screenshotMaxDim` setting is read through a getter for the same reason the service is: it is
// hot (`settings.computerUse.screenshotMaxDim`), and a boot-snapshotted value would need a daemon
// restart to take effect, which Norma's standing rule forbids. Note the registry door does NOT do
// this today — `daemon.ts` passes the value by copy and re-registers the tool on a settings change
// — so this is the same behaviour reached by the mechanism that actually works for a
// construction-time capability set.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { computerToolDefs } from "../agent/tools/computer";
import type { ComputerUseService } from "../agent/computer-use";
import { capabilityServer, type CapabilitySession, type CapabilitySessionDeps } from "./server";

export interface ComputerCapabilityDeps extends CapabilitySessionDeps {
  /** `settings.computerUse.screenshotMaxDim`, re-read per call. */
  screenshotMaxDim?: () => number | undefined;
  /** The daemon's single `ComputerUseService` holder. `undefined` ⇒ computer use was turned off at
   *  runtime; the tool's own first line then refuses with "computer use is not available in this
   *  session", which is exactly what a code session gets in the same state. */
  computerUse(): ComputerUseService | undefined;
}

export function computerCapability(deps: ComputerCapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer(
    {
      key: "computer",
      // `deferred` is deliberately NOT passed: it is a ToolSearch concern for the engine's prompt
      // budget and has no meaning over MCP (the child is handed the tool list up front). Passing
      // `["dispatch"]` here would make the private registry refuse a dispatch call with "load its
      // schema via ToolSearch first" — the exact trap `server.ts` keeps `builtinDeferral` unset for.
      // Today's per-mode deferral is recorded in `NORMA_CAPABILITY_TOOLS` for Task 9 instead.
      // The GETTER is forwarded, not its value: `computerToolDefs` resolves it inside `run`, so a
      // `settings.computerUse.screenshotMaxDim` edit reaches the next call with no daemon restart
      // even though the capability object itself is built once at boot.
      defs: computerToolDefs({ screenshotMaxDim: deps.screenshotMaxDim }),
      schemaMode: "code",
      contextExtras: (session: CapabilitySession) => {
        const service = session.computerUse ?? deps.computerUse();
        return service === undefined ? {} : { computerUse: service };
      },
    },
    deps,
  );
}
