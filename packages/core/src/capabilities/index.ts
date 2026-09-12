// `buildCapabilitiesFor` — the ONE place the daemon's capability servers are assembled, and the
// only thing the session driver needs to know about this directory.
//
// R-8-1: the router owns no tool; the DAEMON owns the capability tools. P8b-36: they are built PER
// SESSION and handed to that session's own `Options.mcpServers`, not to the handle-wide
// construction-time `capabilities` list — see `server.ts`'s header for the measurement behind that
// (there is no per-call session identity on `callTool`, so the identity has to be a closure).
export { capabilityToolName, capabilityServerName, WINTER_CAPABILITY_TOOLS, CAPABILITY_SERVER_KEYS } from "./names";
export type { CapabilityServerKey, CapabilityToolFacts, WinterCapabilityToolName, SessionMode } from "./names";
export type { CapabilitySession, CapabilityServerSpec } from "./server";
export { capabilityServer } from "./server";
export { sessionsCapability, type SessionsCapabilityDeps } from "./sessions";
export { computerCapability, type ComputerCapabilityDeps } from "./computer";
export { browserCapability, type BrowserCapabilityDeps } from "./browser";
export { officeCapability, type OfficeCapabilityDeps } from "./office";
export { researchCapability, type ResearchCapabilityDeps } from "./research";
export { webCapability, type WebCapabilityDeps } from "./web";
export { lspCapability, type LspCapabilityDeps } from "./lsp";
export { externalCapability, type ExternalCapabilityDeps, type ExternalToolSource } from "./external";

import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { CORE_BRAND } from "../runtime-sdk/brand";
import { browserCapability, type BrowserCapabilityDeps } from "./browser";
import { computerCapability, type ComputerCapabilityDeps } from "./computer";
import { officeCapability, type OfficeCapabilityDeps } from "./office";
import { researchCapability, type ResearchCapabilityDeps } from "./research";
import type { CapabilitySession } from "./server";
import { sessionsCapability, type SessionsCapabilityDeps } from "./sessions";
import { webCapability, type WebCapabilityDeps } from "./web";
import { lspCapability, type LspCapabilityDeps } from "./lsp";
import { externalCapability, type ExternalCapabilityDeps } from "./external";

/**
 * The daemon-wide half of the wiring: the instances, stores and closures the capability tools need,
 * built ONCE at boot and shared by every session's servers. Everything session-specific lives in the
 * `CapabilitySession` passed alongside it.
 */
export interface CapabilityDeps {
  sessions: SessionsCapabilityDeps;
  computer: ComputerCapabilityDeps;
  browser: BrowserCapabilityDeps;
  office: OfficeCapabilityDeps;
  research: ResearchCapabilityDeps;
  web: WebCapabilityDeps;
  /** Fix wave (review F7): the `lsp` capability over the daemon's single `LspManager` holder. */
  lsp: LspCapabilityDeps;
  /** Phase 8c Lane 3, Task 3.4: plugin-contributed tools, per session. Optional — absent registers
   *  `external` with zero tools (see `external.ts`'s own header for the real-wiring carry). */
  external?: ExternalCapabilityDeps;
  /**
   * `settings.computerUse.enabled`, read LIVE — a getter, never a boot snapshot.
   *
   * This is the whole hot-reload story now, and it is simply correct rather than deferred: the
   * servers are built when a session starts, so a user who turns computer use off gets no `computer`
   * server on the next session, and one who turns it on gets one — with no daemon restart, and with
   * no help needed from Task 9's `disallowedTools`. (A session already running keeps the tool list
   * it was created with, exactly as an engine session keeps the registry it started its turn with;
   * a toggle-off additionally tears down the shared `ComputerUseService`, so an in-flight capability
   * call fails safe with the tool's own "computer use is not available in this session".)
   */
  computerUseEnabled(): boolean;
}

/**
 * A session's capability servers, in the EXACT shape `Options.mcpServers` takes — keyed by each
 * server's own name.
 *
 * ⚠️ THE KEY IS THE WIRE NAME (N1). On the path P8b-36 chose, the child derives a tool's name from
 * the RECORD KEY, not from the config's `name` field: the SDK's `toWireMcpServers` iterates
 * `Object.entries(servers)` and keys its output by that key, and `makeSdkMcpCallHandler` dispatches
 * incoming `sdk_mcp_call`s by `mcpServers[req.server]` — the key again. A driver that keyed this
 * record by anything other than `server.name` would silently re-open C1: every tool would be
 * registered under a name nothing else in the daemon knows, with every test in this batch green.
 *
 * Returning a keyed RECORD rather than an array is what makes that unrepresentable — there is no
 * mis-keying step left for Task 16 to get wrong, because there is no keying step at all.
 */
export type CapabilityServerRecord = Readonly<Record<string, McpSdkServerConfigWithInstance>>;

/**
 * Build this session's capability servers, ready to spread into `Options.mcpServers`.
 *
 * The session is BAKED IN — each server closes over it, so `callTool` never has to ask who is
 * calling and there is no unbound state to refuse. `CapabilitySession` is a required argument, so
 * "no session" is a compile error rather than a runtime branch. Each server additionally serves only
 * the tools this session's MODE is offered (P8b-37, `server.ts`).
 *
 * A server whose tool set is empty for this mode is KEPT, advertising nothing. Two reasons: the
 * record's key set then depends only on `CAPABILITY_SERVER_KEYS` and the computer-use setting, which
 * is one less thing for Task 16 and the tests to special-case; and a zero-tool MCP server is inert
 * on the wire. Omitting them instead is a one-line change if it is ever ruled the other way.
 *
 * Never throws. The router still validates whatever it is handed (`capabilityServerDescriptors`
 * refuses any tool whose `inputSchema` is not a JSON-Schema object), so a malformed declaration
 * surfaces at the query rather than here.
 */
export function buildCapabilitiesFor(
  session: CapabilitySession,
  deps: CapabilityDeps,
): CapabilityServerRecord {
  const servers: McpSdkServerConfigWithInstance[] = [sessionsCapability(session, deps.sessions)];
  // `computer` is the ONLY conditional server, and the condition is now LIVE — see
  // `computerUseEnabled` above.
  if (deps.computerUseEnabled()) servers.push(computerCapability(session, deps.computer));
  servers.push(browserCapability(session, deps.browser));
  servers.push(officeCapability(session, deps.office));
  servers.push(researchCapability(session, deps.research));
  servers.push(webCapability(session, deps.web));
  servers.push(lspCapability(session, deps.lsp));
  servers.push(externalCapability(session, deps.external ?? {}));
  const record: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const server of servers) record[server.name] = server;
  return record;
}

/**
 * The router's capability-name collision guard, re-provided for the path that no longer has it (N2).
 *
 * `assertNoCapabilityCollision` inside the router only runs when the HANDLE carries capabilities,
 * and P8b-36 moved the host's to each session's own `Options.mcpServers` with the handle's list empty.
 * So the router no longer refuses a same-named server appearing beside a capability — and a
 * settings- or plugin-contributed MCP server called `winter__browser` merged into the same record
 * would silently shadow the daemon-owned one, or be shadowed by it, depending on spread order.
 * Either way the model would be handed a `browser` that is not the host's, under the host's name.
 *
 * Task 16 calls this whenever it merges ANY other server into the session's record. It throws
 * rather than dropping: a collision is a configuration fault with two plausible intents and no safe
 * default, exactly as the router judged it.
 */
export class CapabilityNameCollisionError extends Error {
  readonly code = "capability_name_collision" as const;
  /** The colliding server name — a daemon-owned `winter__<key>` name, or the brand name itself. */
  readonly server: string;
  constructor(server: string, reason: "owned" | "brand" = "owned") {
    super(
      reason === "brand"
        ? `\`${server}\` is the host's own MCP namespace (the brand's \`mcpServerName\`): a server keyed ` +
          `by it would mint \`mcp__${server}__<tool>\` names that the host maps back onto its OWN tool ` +
          `classes and names — so the door refuses the key rather than let a foreign server borrow them`
        : `\`${server}\` is the name of a daemon-owned capability server for this session, and the ` +
          `caller's own \`mcpServers\` already carries it — one of the two would silently not be ` +
          `registered, so the door refuses rather than choose for you`,
    );
    this.name = "CapabilityNameCollisionError";
    this.server = server;
  }
}

export function assertNoCapabilityCollision(
  mcpServers: Readonly<Record<string, unknown>> | undefined,
  ownedNames: Iterable<string> | CapabilityServerRecord,
): void {
  if (mcpServers === undefined) return;
  // Fix-wave re-review N-1: the BRAND NAME is refused too. A configured server keyed exactly
  // `winter` (`CORE_BRAND.mcpServerName`) registers its tools as `mcp__winter__<tool>`; a tool it
  // names `web__web_fetch` or `lsp__lsp` is then the identical string `tool-names.ts`'s
  // `hostToolNameFor` strips to the host's OWN `web_fetch`/`lsp` — the host's gate class (NETWORK /
  // READ_ONLY, silent under every policy including `plan`) and the host's name on the card and the
  // Mac's tool rows, for a tool that is not the host's. The router refuses that name for a capability
  // server for the same reason; this guard is the one door the configured servers pass.
  if (Object.hasOwn(mcpServers, CORE_BRAND.mcpServerName)) throw new CapabilityNameCollisionError(CORE_BRAND.mcpServerName, "brand");
  const owned = typeof (ownedNames as Iterable<string>)[Symbol.iterator] === "function"
    ? (ownedNames as Iterable<string>)
    : Object.keys(ownedNames as CapabilityServerRecord);
  for (const name of owned) {
    if (Object.hasOwn(mcpServers, name)) throw new CapabilityNameCollisionError(name);
  }
}
