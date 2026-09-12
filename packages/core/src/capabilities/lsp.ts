// The `lsp` capability server (fix wave, whole-branch review F7) — the single multi-purpose `lsp`
// tool (definition / references / implementation / hover / symbols / workspace_symbols /
// diagnostics) over the daemon's ONE `LspManager`.
//
// WHY IT EXISTS. Task 17 retired the registry-door `lsp` tool "because Winter's own LSP serves the
// child" — and the measured 0.0.4 advertised set has NO `LSP` (`runtime-sdk/tool-names.ts`:
// `WINTER_ADVERTISED_TOOLS_0_0_4`; the SDK's `descriptors/lsp.ts` is capability-gated and a Winter
// child never gets it). CLAUDE.md's tool surface promises "a single multi-purpose `lsp` tool", so
// this server is that promise on the Winter leg: the same `ToolDefinition` the registry door
// registers (`agent/tools/lsp.ts`'s `lspToolDefs`), the same fence discipline (every file_path
// resolves within the session's read roots BEFORE the manager is touched), the same 1-based
// position convention, the same `LspNotSupportedError` sentinel.
//
// THREE THINGS THIS FILE DOES NOT DO — the `computer.ts` pattern:
//  1. It never builds its own `LspManager`. `deps.lsp` is a GETTER over `daemon.ts`'s single `let
//     lspManager` holder — the same one `settings-apply.ts` reassigns on a hot `lsp.enabled` flip
//     — so one manager serves both doors, its idle-reap timers included.
//  2. It never decides whether LSP is ENABLED. The getter answers `undefined` while the feature is
//     off and the tool's first line then refuses ("lsp is not available in this session"), which
//     a code session got from the registry's "unknown tool" before; the server is still built so
//     the record's key set stays `CAPABILITY_SERVER_KEYS` + the computer-use setting only.
//  3. It reads cwd/roots/tmpDir FROM THE SESSION it was built for — `CapabilitySession` carries
//     exactly the `store.meta(sid).cwd` / `sessionDirs.roots(sid)` / `sessionTmpDir(sid)` the
//     registry door's `cwdOf`/`rootsOf`/`tmpDirOf` closures resolved, baked per session (P8b-36).
//
// AUTO-DIAGNOSTICS-AFTER-EDIT IS NOT HERE. It was never a registry hook: the engine appended
// `autoDiagnosticsSuffix` to a write/edit `tool_result` inside its own `executeCall`, and on the
// Winter leg the edits are the CHILD's (`Edit`/`Write`). The SDK's `Options.hooks` carries a
// `PostToolUse` matcher whose output admits `additionalContext`/`updatedToolOutput` — the honest
// shape for it — but whether a spawned child invokes host hooks is unmeasured, and hooks are the
// plugin-hooks carry (review row 6). Recorded in the fix-wave report; `lsp/auto-diagnostics.ts`
// stays deleted until that measurement.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import type { LspManager } from "../agent/lsp/manager";
import { lspToolDefs } from "../agent/tools/lsp";
import { capabilityServer, type CapabilitySession } from "./server";

export interface LspCapabilityDeps {
  /** The daemon's single `LspManager` holder, read per call. `undefined` ⇒ `settings.lsp.enabled`
   *  is false (or the manager was torn down): the tool refuses with "not available". */
  lsp(): LspManager | undefined;
}

export function lspCapability(session: CapabilitySession, deps: LspCapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer(
    {
      key: "lsp",
      defs: lspToolDefs({
        lsp: () => deps.lsp(),
        cwdOf: () => session.cwd,
        rootsOf: () => session.roots,
        tmpDirOf: () => session.tmpDir,
      }),
    },
    session,
  );
}
