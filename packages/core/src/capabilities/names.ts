// P8b-12 — the CANONICAL names of every daemon-owned capability tool, and the one function that
// builds them.
//
// WHY THIS FILE EXISTS AT ALL. On the Winter leg the daemon's own tools are no longer registry
// entries the engine dispatches; they are MCP tools on in-process servers handed to the child
// through `Options.mcpServers`. Every downstream surface that has to reason about them (Task 9's
// per-mode `disallowedTools`, P8b-25's Winter-name table, the approval gate's classification) keys
// on the WIRE names, so they are written down once, here.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE WIRE-NAME FORM, AND ITS SOURCE (P8b-35; the C1 fix)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// An MCP server is advertised UNDER ITS OWN NAME and its tools are named `mcp__<server>__<tool>`.
// That is not this file's convention, it is the router's, stated in the installed
// `winter-runtime-sdk/dist/door.d.ts` ("PER SERVER, UNDER ITS OWN NAME, so `mcp__<server>__<tool>`
// is the same canonical name on both legs") and implemented in its `dist/index.js`:
// `record[server.name] = server` keys the capability record, `mergedMcpServers(...)` merges it into
// the forwarded `Options.mcpServers` under that key, and `capabilityServerDescriptor` builds
// `{ name: server.name, tools: [{ tool: tool.name, … }] }` for the official leg.
//
// SO THE SERVER'S NAME CARRIES THE BRAND, NOT THE TOOL TOKEN. A server declared `"sessions"` would
// be reached as `mcp__sessions__list_sessions` — one segment short of P8b-12's
// `mcp__winter__sessions__list_sessions`, and short SILENTLY: Task 9's `disallowedTools` entries
// would name tools that do not exist and therefore deny nothing (a chat session would keep
// `computer`), and P8b-25's name table would miss, blanking tool rows in the Mac/iOS renderers.
// Nothing in the type system or in a literal-vs-literal parity test can see that.
//
// P8b-35's answer: the server is NAMED `winter__<key>` (`capabilityServerName`), so the router's own
// `mcp__<server>__<tool>` yields exactly the P8b-12 literal — the same string
// `mcpToolName(CORE_BRAND, "<key>__<tool>")` produces. `test/capabilities/wire-names.test.ts`
// DERIVES each name from the declared server through the router's own path and asserts the two
// agree, so the table can never again describe names the router does not register.
//
// R-1's NAMESPACE IS `winter` (`CORE_BRAND.mcpServerName`) — the daemon's OWN brand namespace, not a
// foreign one being avoided. Pre-rename this pinned the daemon to its OWN old brand token,
// deliberately never `winter` (the SDK's own reserved brand name), to keep the two apart; since
// P9b-7 the daemon's brand equals the SDK's `WINTER_BRAND` except three fields, so `mcpServerName` is genuinely
// `"winter"` for both sides now — that reason no longer exists. The invariant that still matters,
// narrower but load-bearing, is `capabilityServerName`'s own: a capability server's `winter__<key>`
// name can never equal the bare brand name `"winter"` itself, which the router reserves for its
// standing messaging server — the `__<key>` suffix guarantees that. The Mac/iOS renderers key tool
// rows on Winter's names (P8b-25). `mcpToolName` is TWO-ARG — it takes the brand and the WHOLE tool
// token — so the `<server>__<tool>` join happens here.
import { mcpToolName } from "@yanlinglabs/winter-agent-sdk";
import { CORE_BRAND } from "../runtime-sdk/brand";
import type { SessionMode } from "../runtime-sdk/create";

export type { SessionMode };

/** The capability server keys, in the order `buildCapabilitiesFor` returns them.
 *
 *  P8b-33 added `web` to P8b-12's five: every mode disallows the SDK's built-in WebSearch/WebFetch
 *  in 8b (no keys, no dangerous-domain floor), so code keeps the daemon-owned pair. The fix wave
 *  added `lsp` (review F7): the `lsp` tool was retired on the premise that Winter's own LSP serves
 *  the child, and the measured 0.0.4 advertised set has none. Phase 8c Lane 3 (Task 3.4) added
 *  `external`: plugin-contributed tools, forwarded to the owning plugin over its existing RPC —
 *  its tool set is per-plugin and dynamic, so (unlike every other key) it has no corresponding
 *  `WINTER_CAPABILITY_TOOLS` rows; mode scoping for it lives on each `ExternalToolSource.modes`
 *  instead (default `["code"]`, `capabilities/server.ts`'s own documented fallback). */
export const CAPABILITY_SERVER_KEYS = ["sessions", "computer", "browser", "office", "research", "web", "lsp", "external"] as const;
export type CapabilityServerKey = (typeof CAPABILITY_SERVER_KEYS)[number];

/**
 * `capabilityToolName("sessions", "list_sessions")` → `"mcp__winter__sessions__list_sessions"`.
 *
 * The SDK's `mcpToolName(brand, tool)` prefixes `mcp__<brand.mcpServerName>__`; the server key is
 * folded into the tool token because a capability server is forwarded under its OWN name (surface
 * map §1.7) while the tool NAME the child sees is namespaced by the brand. Deliberately a function
 * and not a template literal at each call site: `mcpServerName` is brand-owned, and a dev/dist
 * profile split (or any later re-brand) must move every name at once or none.
 */
export function capabilityToolName(serverKey: string, tool: string): string {
  return mcpToolName(CORE_BRAND, `${serverKey}__${tool}`);
}

/**
 * The NAME a capability server is declared with — `winter__sessions`, `winter__browser`, … (P8b-35).
 *
 * The router keys its capability record by `server.name`, merges the server into the forwarded
 * `Options.mcpServers` under it, and a child names that server's tools `mcp__<server>__<tool>`. So
 * the brand segment has to live HERE, on the server, for the wire name to come out as P8b-12's
 * literal. Declared as `"sessions"` instead, every name in the table below would be one segment
 * short of what the child actually sees — see this file's header for why that is silent.
 *
 * `winter__<key>` can never equal `brand.mcpServerName` (`"winter"`), which is the one name the
 * router refuses for a capability server (it would shadow the standing messaging server).
 */
export function capabilityServerName(serverKey: string): string {
  return `${CORE_BRAND.mcpServerName}__${serverKey}`;
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
export const WINTER_CAPABILITY_TOOLS = {
  // `sessions` — dispatch's orchestration + fleet-management surface (`modes: ["dispatch"]` on all
  // three defs; `list_sessions`/`manage_session` carry `deferred: true`, `session_spawn` does not).
  "mcp__winter__sessions__session_spawn": { modes: ["dispatch"] },
  "mcp__winter__sessions__list_sessions": { modes: ["dispatch"], deferred: true },
  "mcp__winter__sessions__manage_session": { modes: ["dispatch"], deferred: true },
  // `computer` — `modes: ["code","dispatch"]`, `deferred: ["dispatch"]` (immediate in code, loaded
  // via ToolSearch in dispatch). Its PRESENCE additionally follows the LIVE
  // `settings.computerUse.enabled`, read when the session's servers are built (`index.ts`).
  "mcp__winter__computer__computer": { modes: ["code", "dispatch"], deferred: ["dispatch"] },
  // `browser` — the only capability tool eligible in all three modes. Chat sees a READ-ONLY verb
  // set, enforced INSIDE the capability (`browser.ts`'s `argsByMode`, resolved from the caller's
  // mode), because a construction-time capability set cannot express a per-ACTION subset and a
  // whole-tool `disallowedTools` entry would take the read verbs away too.
  "mcp__winter__browser__browser": { modes: ["code", "dispatch", "chat"], deferred: ["code", "dispatch"] },
  // `office` — the three LibreOffice-bridge tools, `modes: ["code","dispatch"]`, never deferred.
  "mcp__winter__office__docs": { modes: ["code", "dispatch"] },
  "mcp__winter__office__sheets": { modes: ["code", "dispatch"] },
  "mcp__winter__office__slides": { modes: ["code", "dispatch"] },
  // `research` (C-6) — Winter's OWN web surface for chat and dispatch, not the SDK's
  // WebSearch/WebFetch: these two carry the Exa key and the dangerous-domain floor (Winter map §5.1
  // trap (ii)). Never deferred — `search.ts`'s own note explains why chat's small toolset should
  // not pay a ToolSearch round trip for them.
  "mcp__winter__research__Search": { modes: ["chat", "dispatch"] },
  "mcp__winter__research__ReadPage": { modes: ["chat", "dispatch"] },
  // `web` (P8b-33) — CODE's web surface, for the same reason `research` exists for chat: the SDK's
  // built-in WebSearch/WebFetch are disallowed in every mode in 8b, so without these two a code
  // session would have no web access at all. `modes: ["code"]`, `deferred: true` (registry door).
  "mcp__winter__web__web_fetch": { modes: ["code"], deferred: true },
  "mcp__winter__web__web_search": { modes: ["code"], deferred: true },
  // `lsp` (fix wave, review F7) — the single multi-purpose language-server tool, reinstated as a
  // capability: the 0.0.4 child advertises no `LSP` of its own. Today's registration verbatim:
  // no `modes` on the def (⇒ `["code"]`), `deferred: true`.
  "mcp__winter__lsp__lsp": { modes: ["code"], deferred: true },
} as const satisfies Readonly<Record<string, CapabilityToolFacts>>;

export type WinterCapabilityToolName = keyof typeof WINTER_CAPABILITY_TOOLS;
