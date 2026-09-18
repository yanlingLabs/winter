// The `research` capability server (C-6 / P8b-12) — **`Search`, and nothing else**: chat's and
// dispatch's own search surface, beside the runtime's claude-shaped web tools.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// WHY `Search` IS STILL WINTER'S TOOL WHEN THE CHILD HAS ITS OWN WebSearch
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Because chat asks a question and needs an ANSWER. `Search` is Exa's answer mode (`search.ts`): one
// call, a written answer, its sources listed. `WebSearch` returns links to chase — and chat has no
// page-reading tool to chase them with, by design. That is the user's ruling (2026-09-18), and it is
// the ONLY remaining reason a daemon-owned web tool exists: the earlier ones (the Exa key and the
// dangerous-domain floor being daemon state a built-in could not reach) expired at agent SDK 0.0.17,
// which hands the child both through `Options.web`.
//
// `ReadPage` and the ephemeral multi-page research runner LEFT with the same ruling. The child's own
// `WebFetch` reads a page the way claude does — locally, with a digest pass on `pins.research` — and
// answer-mode `Search` covers the multi-page report the runner used to write. Neither has a
// daemon-side counterpart any more, and nothing here should grow one back without a ruling.
//
// THE KEY IS READ AT CALL TIME, NEVER AT CONSTRUCTION, AND NEVER IN `listTools()`. That is not a
// convention this file adopts — it is the shape of the tool itself: `deps.secret` is a closure
// `Search` `await`s inside `run`, and `listTools()` renders only name/description/schema through
// `ToolRegistry.specFor`. Nothing in this module ever holds key material; nothing in this module can.
// `test/capabilities/research.test.ts` pins it: no key anywhere in the serialized `listTools()`,
// nothing reading the store to build it, and a fake Exa on `127.0.0.1:0` receiving the key HEADER for
// a real `Search` call.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { searchToolDefs, type SearchToolDeps } from "../agent/tools/search";
import { capabilityServer, type CapabilitySession } from "./server";

export interface ResearchCapabilityDeps {
  /** `Search`'s deps — the SAME `audit`/`secret`/`dangerousDomainsAdded` closures `daemon.ts` hands
   *  `registerSearchTool`. `secret` is `(name) => secrets.get(name)` over the daemon's single
   *  `SecretStore`; it is CALLED inside `run`, never here. */
  search: SearchToolDeps;
}

export function researchCapability(session: CapabilitySession, deps: ResearchCapabilityDeps): McpSdkServerConfigWithInstance {
  // THE OTHER HALF OF THE EXA GATE (2026-09-18 ruling). `Search` is Exa `/answer`, which REQUIRES a
  // key, so with none stored the tool cannot work at all and the runtime's own `WebSearch` is exposed
  // in its place (`mode-options.ts`'s `disallowedToolsFor`, which names `Search` in `disallowedTools`
  // in exactly this case). Both doors must move together on the SAME value — see
  // `CapabilitySession.exaKeyPresent`, whose absence reads as "a key is stored" here too.
  //
  // A zero-tool server is KEPT rather than dropped, exactly as a mode-filtered one is: the record's
  // key set stays `CAPABILITY_SERVER_KEYS` (`index.ts`'s own contract) and a server advertising
  // nothing is inert on the wire.
  const defs = session.exaKeyPresent === false ? [] : searchToolDefs(deps.search);
  return capabilityServer({ key: "research", defs }, session);
}
