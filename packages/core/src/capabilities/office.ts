// The `office` capability server (P8b-12) — `docs`, `sheets`, `slides`: the agent's vocabulary over
// the LibreOffice/UNO bridge the Mac app hosts.
//
// THREE TOOLS, ONE SERVER, because they are one capability: the same panel-command transport, the
// same availability gate, and the same `store.dirs(sessionId)` FENCE. That fence is the reason the
// deps must be the daemon's own closures and not this file's: `dirsOf` is deliberately the narrower
// `store.dirs` source (never `ctx.roots`), chosen so the daemon's fence and
// `OfficeAgentBroker.Host.workingDirectories`' app-side fence answer "this session's working
// directories" identically. A second source here would make them disagree in exactly the cases that
// matter — a dirGrant-adopted directory the app has never heard of.
//
// EVENTS: `panel_command` only (no tab minting — office documents open into the panel through the
// app's own command handling). Pinned against the registry door by
// `test/capabilities/panel-emission-parity.test.ts` (P8b-20).
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { docsToolDefs, type DocsToolDeps } from "../agent/tools/docs";
import { sheetsToolDefs, type SheetsToolDeps } from "../agent/tools/sheets";
import { slidesToolDefs, type SlidesToolDeps } from "../agent/tools/slides";
import { capabilityServer, type CapabilitySessionDeps } from "./server";

/** The three tools take the identical trio; `daemon.ts` wires one set of closures to all three. */
export interface OfficeCapabilityDeps extends CapabilitySessionDeps {
  office: DocsToolDeps & SheetsToolDeps & SlidesToolDeps;
}

export function officeCapability(deps: OfficeCapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer(
    {
      key: "office",
      defs: [
        ...docsToolDefs(deps.office),
        ...sheetsToolDefs(deps.office),
        ...slidesToolDefs(deps.office),
      ],
      // `modes: ["code","dispatch"]` on all three; none carries `argsByMode`, so this is inert
      // beyond naming the widest mode served.
      schemaMode: "code",
    },
    deps,
  );
}
