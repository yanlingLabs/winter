// `buildCapabilitiesFor` — the ONE place the daemon's capability servers are assembled, and the
// only thing the session driver needs to know about this directory.
//
// R-8-1: the router owns no tool; the DAEMON owns the capability tools. P8b-36: they are built PER
// SESSION and handed to that session's own `Options.mcpServers`, not to the handle-wide
// construction-time `capabilities` list — see `server.ts`'s header for the measurement behind that
// (there is no per-call session identity on `callTool`, so the identity has to be a closure).
export { capabilityToolName, capabilityServerName, NORMA_CAPABILITY_TOOLS, CAPABILITY_SERVER_KEYS } from "./names";
export type { CapabilityServerKey, CapabilityToolFacts, NormaCapabilityToolName, SessionMode } from "./names";
export type { CapabilitySession, CapabilityServerSpec } from "./server";
export { capabilityServer } from "./server";
export { sessionsCapability, type SessionsCapabilityDeps } from "./sessions";
export { computerCapability, type ComputerCapabilityDeps } from "./computer";
export { browserCapability, type BrowserCapabilityDeps } from "./browser";
export { officeCapability, type OfficeCapabilityDeps } from "./office";
export { researchCapability, type ResearchCapabilityDeps } from "./research";
export { webCapability, type WebCapabilityDeps } from "./web";

import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { browserCapability, type BrowserCapabilityDeps } from "./browser";
import { computerCapability, type ComputerCapabilityDeps } from "./computer";
import { officeCapability, type OfficeCapabilityDeps } from "./office";
import { researchCapability, type ResearchCapabilityDeps } from "./research";
import type { CapabilitySession } from "./server";
import { sessionsCapability, type SessionsCapabilityDeps } from "./sessions";
import { webCapability, type WebCapabilityDeps } from "./web";

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
 * Build this session's capability servers, in `CAPABILITY_SERVER_KEYS` order.
 *
 * The session is BAKED IN — each server closes over it, so `callTool` never has to ask who is
 * calling and there is no unbound state to refuse. `CapabilitySession` is a required argument, so
 * "no session" is a compile error rather than a runtime branch.
 *
 * Never throws. The router still validates whatever it is handed (`capabilityServerDescriptors`
 * refuses any tool whose `inputSchema` is not a JSON-Schema object, even on a Winter-only host), so
 * a malformed declaration surfaces at the query rather than here.
 */
export function buildCapabilitiesFor(
  session: CapabilitySession,
  deps: CapabilityDeps,
): readonly McpSdkServerConfigWithInstance[] {
  const servers: McpSdkServerConfigWithInstance[] = [sessionsCapability(session, deps.sessions)];
  // `computer` is the ONLY conditional server, and the condition is now LIVE — see
  // `computerUseEnabled` above.
  if (deps.computerUseEnabled()) servers.push(computerCapability(session, deps.computer));
  servers.push(browserCapability(session, deps.browser));
  servers.push(officeCapability(session, deps.office));
  servers.push(researchCapability(session, deps.research));
  servers.push(webCapability(session, deps.web));
  return servers;
}
