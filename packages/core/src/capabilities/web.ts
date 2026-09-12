// The `web` capability server (ruling P8b-33) — `web_fetch` and `web_search`: code's web surface.
//
// WHY IT EXISTS, and it is the same argument `research.ts` makes for chat: in 8b EVERY mode
// disallows the SDK's built-in `WebSearch`/`WebFetch`, because a built-in has neither Winter's stored
// keys nor its dangerous-domain floor. Chat/dispatch keep `Search`/`ReadPage`; code keeps these two,
// daemon-owned, over MCP. Without this server, disallowing the built-ins would leave a code session
// with no web access at all.
//
// The same three floors apply, through the same closures (Winter map §5.1 trap (ii)):
//
//   * **The Brave key** — `web_search` reaches it via `deps.secret(WEB_SEARCH_API_KEY_SECRET)`,
//     `await`ed INSIDE `run`. Never at construction, never in `listTools()` output; this module
//     never holds key material and cannot.
//   * **`ssrfGuard` / the dangerous-domain floor** — `web_fetch` is Winter's only sanctioned network
//     egress (bash's sandbox denies network by design), and its resolver-level guard re-checks every
//     redirect hop.
//   * **The audit line** — one `{kind:"network", tool, url|query, outcome}` per call, on every
//     outcome, through the daemon's single `AuditLog`. Never the key.
//
// `web_fetch`/`web_search` are `modes: ["code"]`, `deferred: true` on the registry door. The
// deferral is NOT forwarded (see `computer.ts`'s note); it is recorded in `WINTER_CAPABILITY_TOOLS`
// for Task 9's per-mode exposure table.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { webToolDefs, type WebToolDeps } from "../agent/tools/web";
import { capabilityServer, type CapabilitySession } from "./server";

export interface WebCapabilityDeps {
  /** The SAME `audit`/`secret` closures `daemon.ts` hands `registerWebTools` — one `AuditLog`, one
   *  `SecretStore`, no second handle to keep in sync. */
  web: WebToolDeps;
}

export function webCapability(session: CapabilitySession, deps: WebCapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer({ key: "web", defs: webToolDefs(deps.web) }, session);
}
