// `buildCapabilities` — the ONE place the daemon's capability servers are assembled, and the only
// thing `daemon.ts` needs to know about this directory.
//
// R-8-1: the router owns no tool; the DAEMON owns the capability tools and hands them to the router,
// which forwards them into every spawned Winter child under each server's own name.
export { capabilityToolName, NORMA_CAPABILITY_TOOLS, CAPABILITY_SERVER_KEYS } from "./names";
export type { CapabilityServerKey, CapabilityToolFacts, NormaCapabilityToolName, SessionMode } from "./names";
export type { CapabilitySession, CapabilitySessionDeps } from "./server";
export { capabilityServer } from "./server";
export { createCapabilitySessionBinding, type CapabilitySessionBinding } from "./current-session";
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
import { webCapability, type WebCapabilityDeps } from "./web";
import type { CapabilitySessionDeps } from "./server";
import { sessionsCapability, type SessionsCapabilityDeps } from "./sessions";

export interface BuildCapabilitiesDeps extends CapabilitySessionDeps {
  sessions: Omit<SessionsCapabilityDeps, keyof CapabilitySessionDeps>;
  computer: Omit<ComputerCapabilityDeps, keyof CapabilitySessionDeps>;
  browser: Omit<BrowserCapabilityDeps, keyof CapabilitySessionDeps>;
  office: Omit<OfficeCapabilityDeps, keyof CapabilitySessionDeps>;
  research: Omit<ResearchCapabilityDeps, keyof CapabilitySessionDeps>;
  web: Omit<WebCapabilityDeps, keyof CapabilitySessionDeps>;
  /**
   * `settings.computerUse.enabled` AS READ AT BOOT — and it has to be, which is worth stating
   * plainly because it is the one place 8b's capability set is less live than the registry's.
   *
   * `RuntimeSdkOptions.capabilities` is consumed at `createRuntimeSdk` time (surface map §1.7):
   * the router derives each server's descriptors there, once. So whether the `computer` SERVER
   * EXISTS follows the boot-time setting, mirroring `daemon.ts:1049`'s own boot guard.
   *
   * The hot toggle is still honoured, one layer up: Task 9 computes each session's
   * `disallowedTools` from the LIVE setting, so turning computer use off on a running daemon makes
   * `mcp__norma__computer__computer` disallowed for every session created afterwards, and turning
   * it back on re-allows it — with no restart. A session already running keeps the tool list it
   * was created with, exactly as an engine session keeps the registry it started its turn with.
   * The residual gap is narrow and recorded: a daemon that BOOTED with computer use off has no
   * `computer` capability server to allow, so enabling it mid-life reaches engine sessions only
   * until the next restart. Task 15's hot-reload sweep owns closing that if it is worth closing.
   */
  computerUseEnabled: boolean;
}

/**
 * Build the capability servers, in `CAPABILITY_SERVER_KEYS` order.
 *
 * Never throws: a malformed capability declaration is a CONSTRUCTION refusal inside the router
 * (`capabilityServerDescriptors` validates every `inputSchema` is a JSON-Schema object, even on a
 * Winter-only host), and `daemon.ts` catches that and boots with the Winter leg refusing. So the
 * daemon's boot test asserts the handle was actually built AND that the capability names arrived —
 * a silently-empty list would otherwise look exactly like success.
 */
export function buildCapabilities(deps: BuildCapabilitiesDeps): readonly McpSdkServerConfigWithInstance[] {
  const currentSession = (): ReturnType<CapabilitySessionDeps["currentSession"]> => deps.currentSession();
  const servers: McpSdkServerConfigWithInstance[] = [
    sessionsCapability({ ...deps.sessions, currentSession }),
  ];
  // `computer` is the ONLY conditional server — every other capability exists whenever the daemon
  // does, exactly as its registry counterpart does (the gate below is `daemon.ts:1049`'s own).
  if (deps.computerUseEnabled) servers.push(computerCapability({ ...deps.computer, currentSession }));
  servers.push(browserCapability({ ...deps.browser, currentSession }));
  servers.push(officeCapability({ ...deps.office, currentSession }));
  servers.push(researchCapability({ ...deps.research, currentSession }));
  servers.push(webCapability({ ...deps.web, currentSession }));
  return servers;
}
