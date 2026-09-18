// The `research` capability server (C-6 / P8b-12) — `Search` and `ReadPage`: chat's and dispatch's
// web surface.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THESE ARE WINTER'S TOOLS AND NOT THE SDK'S WebSearch/WebFetch
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// WS-06 §5 originally folded `Search`/`ReadPage` into the SDK's built-in web tools "in the chat-mode
// advertised set". C-6 overturned that, and the reason is daemon state the built-ins cannot have
// (Winter map §5.1 trap (ii)):
//
//   1. **The Exa key.** `Search` reaches it through `deps.secret(EXA_API_KEY_SECRET)` — the daemon's
//      `KeychainSecretStore`. A built-in WebSearch has no key and would simply fail; worse, a
//      capability that resolved the key EARLY would put it somewhere it could be observed.
//   2. **The dangerous-domain floor.** `dangerousDomainsAdded` is the per-project, hot, user-added
//      half of the effective list, shared by `Search`, `ReadPage`, the research runner and the
//      browser tool as literally the same function reference. `ReadPage` has NO approval flow, so a
//      match is a hard refusal; `Search` withholds a matching result before the model ever sees it.
//   3. **`ssrfGuard`** — page-core's resolver-level guard (metadata IPs, private ranges, redirect
//      re-checks on every hop).
//
// THE KEY IS READ AT CALL TIME, NEVER AT CONSTRUCTION, AND NEVER IN `listTools()`. That is not a
// convention this file adopts — it is the shape of the tools themselves: `deps.secret` is a
// closure the tool `await`s inside `run`, and `listTools()` renders only name/description/schema
// through `ToolRegistry.specFor`. Nothing in this module ever holds key material; nothing in this
// module can. `test/capabilities/research.test.ts` pins all three: no key anywhere in the
// serialized `listTools()`, a metadata-IP URL refused with today's message, and a fake Exa on
// `127.0.0.1:0` receiving the key header for a real `Search` call.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { readPageToolDefs, type ReadPageDeps } from "../agent/tools/read-page";
import { searchToolDefs, type SearchToolDeps } from "../agent/tools/search";
import { capabilityServer, type CapabilitySession } from "./server";

export interface ResearchCapabilityDeps {
  /** `Search`'s deps — the SAME `audit`/`secret`/`dangerousDomainsAdded` closures `daemon.ts` hands
   *  `registerSearchTool`. `secret` is `(name) => secrets.get(name)` over the daemon's single
   *  `SecretStore`; it is CALLED inside `run`, never here. */
  search: SearchToolDeps;
  /** `ReadPage`'s deps — the SAME `PageCache` instance the ephemeral research runner shares, so a
   *  report's citations resolve from the identical cache a follow-up `ReadPage` would hit. */
  readPage: ReadPageDeps;
}

export function researchCapability(session: CapabilitySession, deps: ResearchCapabilityDeps): McpSdkServerConfigWithInstance {
  // THE OTHER HALF OF THE EXA GATE (2026-09-18 ruling). `Search` is Exa `/answer`, which REQUIRES a
  // key, so with none stored the tool cannot work at all and the runtime's own `WebSearch` is exposed
  // in its place (`mode-options.ts`'s `disallowedToolsFor`, which names `Search` in `disallowedTools`
  // in exactly this case). Both doors must move together on the SAME value — see
  // `CapabilitySession.exaKeyPresent`, whose absence reads as "a key is stored" here too.
  //
  // A zero-tool server is kept rather than dropped, exactly as a mode-filtered one is: the record's
  // key set stays `CAPABILITY_SERVER_KEYS` (`index.ts`'s own contract) and a server advertising
  // nothing is inert on the wire.
  const defs = [
    ...(session.exaKeyPresent === false ? [] : searchToolDefs(deps.search)),
    ...readPageToolDefs(deps.readPage),
  ];
  return capabilityServer({ key: "research", defs }, session);
}
