// P8b-12 — the CANONICAL names of every daemon-owned capability tool, and the one function that
// builds them.
//
// WHY THIS FILE EXISTS AT ALL. On the Winter leg the daemon's own tools are no longer registry
// entries the engine dispatches; they are MCP tools on in-process servers the router forwards into
// each spawned child (`RuntimeSdkOptions.capabilities`, surface map §1.7). A child sees them under
// their MCP wire names — `mcp__<mcpServerName>__<server>__<tool>` — and every downstream surface
// that has to reason about them (Task 9's per-mode `disallowedTools`, P8b-25's Norma-name table,
// the approval gate's classification) keys on those strings. One table, built by one function, so
// the strings can never be hand-copied apart.
//
// R-1 PINS THE NAMESPACE TO `norma`, NEVER `winter`: `NORMA_BRAND.mcpServerName` is `"norma"`, and
// the Mac/iOS renderers key tool rows on Norma's names (P8b-25). `mcpToolName` is TWO-ARG — it
// takes the brand and the WHOLE tool token — so the `<server>__<tool>` join happens here, in the
// caller, and is asserted against the P8b-12 literal by `test/capabilities/names.test.ts`.
import { mcpToolName } from "@yanlinglabs/winter-agent-sdk";
import { NORMA_BRAND } from "../runtime-sdk/brand";
import type { SessionMode } from "../runtime-sdk/create";

export type { SessionMode };

/** The five capability server keys (P8b-12), in the order `buildCapabilities` returns them. */
export const CAPABILITY_SERVER_KEYS = ["sessions", "computer", "browser", "office", "research"] as const;
export type CapabilityServerKey = (typeof CAPABILITY_SERVER_KEYS)[number];

/**
 * `capabilityToolName("sessions", "list_sessions")` → `"mcp__norma__sessions__list_sessions"`.
 *
 * The SDK's `mcpToolName(brand, tool)` prefixes `mcp__<brand.mcpServerName>__`; the server key is
 * folded into the tool token because a capability server is forwarded under its OWN name (surface
 * map §1.7) while the tool NAME the child sees is namespaced by the brand. Deliberately a function
 * and not a template literal at each call site: `mcpServerName` is brand-owned, and a dev/dist
 * profile split (or any later re-brand) must move every name at once or none.
 */
export function capabilityToolName(serverKey: string, tool: string): string {
  return mcpToolName(NORMA_BRAND, `${serverKey}__${tool}`);
}

/**
 * What Task 9's per-mode exposure table has to reproduce for each capability tool.
 *
 * `modes` is TODAY'S REGISTRATION, verbatim — the `modes` field on the tool's own `ToolDefinition`
 * (registry.ts; absent there means `["code"]`). It is NOT a wish list: the whole point of recording
 * it here is that Task 9's `CAPABILITY_TOOL_MODES` is diffed against it, so a capability that
 * silently widened a tool's reach (chat gaining `bash`-adjacent power, dispatch gaining a code-only
 * tool) fails a test rather than shipping.
 *
 * `deferred` mirrors `ToolDefinition.deferred` the same way. It carries NO meaning for the Winter
 * leg's `Options` — a spawned child has no ToolSearch deferral over MCP tools — and is recorded
 * only so Task 9 can reproduce today's per-mode EXPOSURE faithfully (a tool that is deferred in a
 * mode is reachable there, just not advertised up front).
 */
export interface CapabilityToolFacts {
  modes: readonly SessionMode[];
  deferred?: true | readonly SessionMode[];
}

/**
 * THE table. A plain literal — no computed keys — so that Task 9's `CAPABILITY_TOOL_MODES` can be
 * diffed against it key-for-key by a test that reads both as data, and so that `grep`ping for a
 * capability tool name in this repo lands here.
 *
 * The literal spellings are asserted equal to `capabilityToolName(key, tool)` in
 * `test/capabilities/names.test.ts`; that test is what keeps the two spellings from drifting.
 */
export const NORMA_CAPABILITY_TOOLS = {
  // `sessions` — dispatch's orchestration + fleet-management surface (`modes: ["dispatch"]` on all
  // three defs; `list_sessions`/`manage_session` carry `deferred: true`, `session_spawn` does not).
  "mcp__norma__sessions__session_spawn": { modes: ["dispatch"] },
  "mcp__norma__sessions__list_sessions": { modes: ["dispatch"], deferred: true },
  "mcp__norma__sessions__manage_session": { modes: ["dispatch"], deferred: true },
  // `computer` — `modes: ["code","dispatch"]`, `deferred: ["dispatch"]` (immediate in code, loaded
  // via ToolSearch in dispatch). Its PRESENCE additionally follows `settings.computerUse.enabled`
  // at boot — see `buildCapabilities` in `index.ts` for why that is construction-time.
  "mcp__norma__computer__computer": { modes: ["code", "dispatch"], deferred: ["dispatch"] },
} as const satisfies Readonly<Record<string, CapabilityToolFacts>>;

export type NormaCapabilityToolName = keyof typeof NORMA_CAPABILITY_TOOLS;
