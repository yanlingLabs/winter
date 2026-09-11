// The `browser` capability server (P8b-12) — the agent's browser over CDP, driven through the panel
// command round trip.
//
// ONE SERVER, THREE MODES, AND CHAT IS READ-ONLY *INSIDE* IT. `browser` is the only capability tool
// eligible in all three modes, and chat sees a strictly smaller VERB SET (read verbs only). That is
// not expressible in Task 9's per-mode `disallowedTools`, which names whole tools, and it is not
// expressible by a second server either — the tool is ONE tool by design (b2 spec §1), and a second
// registered name would be a second browser in the daemon. So it is enforced here, and it costs
// nothing extra: `browser.ts` already declares `argsByMode` (chat ⇒ `BrowserReadArgs`, code/dispatch
// ⇒ `BrowserFullArgs`), the private registry's `execute` resolves it from `ctx.mode`, and an
// interact verb in chat fails ARGUMENT VALIDATION with the registry's own wording —
// `invalid arguments for browser: verb` — which IS today's refusal. There is no prose message to
// keep in sync because today's door has none either.
//
// `listTools()` therefore advertises the WIDEST schema (`schemaMode: "code"`). Advertising the
// narrow one would tell a code session it may not call a verb the same session's `callTool` would
// happily accept — the exact silent narrowing `ToolRegistry.specFor`'s own doc comment warns about.
//
// PANEL EVENTS SURVIVE THE MOVE (P8b-20) because the deps are the same closures `daemon.ts` hands
// `registerBrowserTool`: `openTab` is `mintPanelTab(hub, …)` (→ `panel_tab_opened` +
// `panel_tab_activated`) and `dispatch` is `panelCommands.dispatch` (→ `panel_command`). The
// capability neither emits nor re-emits anything itself; `test/capabilities/panel-emission-parity.test.ts`
// compares the two doors' event sequences against one recording hub.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { browserToolDefs, type BrowserToolDeps } from "../agent/tools/browser";
import { capabilityServer, type CapabilitySessionDeps } from "./server";

export interface BrowserCapabilityDeps extends CapabilitySessionDeps {
  /** The SAME `tabs`/`openTab`/`dispatch`/`harnesses`/`dangerousDomainsAdded` closures `daemon.ts`
   *  hands the registry door. Handing this server its own panel-command registry would make a
   *  dispatched command unanswerable by `panel.commandResult`. */
  browser: BrowserToolDeps;
}

export function browserCapability(deps: BrowserCapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer(
    {
      key: "browser",
      // `deferred: ["code","dispatch"]` is NOT forwarded — see `computer.ts`'s note: deferral is the
      // engine's prompt-budget mechanism and would make the private registry refuse every code and
      // dispatch call. Recorded in `NORMA_CAPABILITY_TOOLS` for Task 9 instead.
      defs: browserToolDefs(deps.browser),
      schemaMode: "code",
    },
    deps,
  );
}
