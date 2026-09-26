#!/usr/bin/env bun
/**
 * Winter Phase 8d (P8d-15, WS-17 §6 row 9): generates `packages/core/capability-matrix.json` —
 * Winter's OWN rows of the cross-repo capability matrix (mode × runtime × surface). The SDK repo
 * owns the other axes (provider/protocol capabilities); this file's whole scope is "what Winter's
 * own daemon/CLI/app/remote-gateway code lets each combination reach", derived from three real
 * predicates rather than hand-typed:
 *
 *   1. **The runtime axis** — WS-23 retired the official (`claude-agent`) leg: every mode, Claude
 *      models included, runs on the Winter leg (`runtime-sdk/create.ts` tells the router
 *      `hasClaudePeer: false`, and `session-driver.ts`'s `decideRuntime` refuses any other answer).
 *      The `claude-agent` column stays, because the protocol keeps the value for sessions the leg
 *      created (ruling R4) — every cell in it is `correctly-unavailable`.
 *   2. **`REMOTE_ALLOWED_METHODS`** (`ipc/server.ts`) — a remote (iOS) client CAN reach
 *      `session.create`/`session.setModel` for every mode `REMOTE_ELIGIBLE_SESSION_MODES` names
 *      (`code`/`dispatch`/`chat` — Chat Slice C lifted chat's remote gate, SP3.4 added remote
 *      session.create). Winter Phase 8d fix round 1: `REMOTE_ELIGIBLE_SESSION_MODES` is now
 *      EXPORTED from `ipc/server.ts` and imported directly here — Winter's own capability-matrix
 *      generator is an in-repo consumer with no dependency-direction problem, unlike the CLI
 *      surface rule below.
 *   3. **The mode tool registry** (`runtime-sdk/mode-options.ts`'s `disallowedToolsFor`) — chat's
 *      own exclusions (the Winter built-ins chat has never offered, `CHAT_DISALLOWED_BUILTINS`)
 *      are read here and folded into chat's `reason` text, so "chat is implemented on the Winter
 *      leg" carries the caveat that its tool surface is narrower BY DESIGN, not an oversight this
 *      matrix would otherwise hide.
 *
 * **CLI/TUI surface reachability is NOT a daemon-side predicate at all** — `packages/cli/src/
 * session-mode.ts`'s own top comment states it directly ("code = TUI + macOS app + iOS app;
 * chat/cowork = apps only; dispatch = apps + orb. The TUI/CLI is CODE-ONLY") and `packages/core`
 * has no dependency on `packages/cli` to import it from (the reverse is true). That fact is
 * therefore a literal here too, with the same citation discipline: named, sourced, and covered by
 * the same drift test.
 *
 * Run: `bun run packages/core/scripts/capability-matrix.ts` (writes the JSON). The drift test
 * imports `buildCapabilityMatrix` directly and diffs its output against the committed file —
 * regenerating is this script's only job; the test never shells out to it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { disallowedToolsFor } from "../src/runtime-sdk/mode-options";
import { REMOTE_ELIGIBLE_SESSION_MODES } from "../src/ipc/server";

export type CapabilityMode = "code" | "dispatch" | "chat";
export type CapabilityRuntime = "winter-agent" | "claude-agent";
export type CapabilitySurface = "cli" | "mac" | "ios-remote";
export type CapabilityCell = "implemented" | "correctly-unavailable";

export interface CapabilityMatrixRow {
  mode: CapabilityMode;
  runtime: CapabilityRuntime;
  surface: CapabilitySurface;
  cell: CapabilityCell;
  reason: string;
}

export interface CapabilityMatrix {
  schema: 1;
  generatedBy: "packages/core/scripts/capability-matrix.ts";
  rows: CapabilityMatrixRow[];
}

/** `packages/cli/src/session-mode.ts`'s own top-of-file doc, copied as a literal (genuine
 *  cross-package import direction: `cli` depends on `core`, never the reverse — `core` cannot
 *  import from `cli`) — the TUI/CLI is code-only; dispatch and chat are "apps [+ orb]" only. This
 *  is the ONE remaining duplicated literal (fix round 1 retired the other, `REMOTE_ELIGIBLE_
 *  SESSION_MODES`, by exporting it from `ipc/server.ts` instead); the drift test still pins this
 *  one so a future edit to `session-mode.ts`'s rule without updating this generator fails loud. */
const CLI_REACHABLE_MODES: readonly CapabilityMode[] = ["code"];

/** Every surface reaches every mode except the CLI's own code-only carve-out above. Mac (the app +
 *  the orb) and iOS-remote (the imported `REMOTE_ELIGIBLE_SESSION_MODES`) agree exactly: both
 *  offer all three modes. */
function surfaceReachesMode(surface: CapabilitySurface, mode: CapabilityMode): boolean {
  if (surface === "cli") return CLI_REACHABLE_MODES.includes(mode);
  if (surface === "mac") return true;
  return REMOTE_ELIGIBLE_SESSION_MODES.has(mode); // ios-remote
}

function surfaceUnreachableReason(surface: CapabilitySurface, mode: CapabilityMode): string {
  if (surface === "cli") {
    return `the TUI/CLI is code-only (packages/cli/src/session-mode.ts) — ${mode} sessions are apps${mode === "dispatch" ? "/orb" : ""}-only and cannot be created or attached from here`;
  }
  return `unreachable for this surface`; // unused today — mac/ios-remote reach every mode
}

/** WS-23: the one answer for the `claude-agent` column, in every mode. */
const OFFICIAL_LEG_RETIRED_REASON = "the official claude runtime was retired (WS-23): no session is created on it, and a session recorded on it is adopted onto the Winter leg at its next resume (session-driver.ts's adoptLegacyRecord)";

const CHAT_MODE_TOOL_NOTE = (() => {
  // Chat's answer with an Exa key assumed present (the narrower surface).
  const excluded = disallowedToolsFor("chat", {});
  return `chat's own tool registry excludes ${excluded.length} Winter built-in(s) by design (runtime-sdk/mode-options.ts's disallowedToolsFor) — narrower by mode policy, not a runtime/surface gate`;
})();

export function buildCapabilityMatrix(): CapabilityMatrix {
  const modes: CapabilityMode[] = ["code", "dispatch", "chat"];
  const runtimes: CapabilityRuntime[] = ["winter-agent", "claude-agent"];
  const surfaces: CapabilitySurface[] = ["cli", "mac", "ios-remote"];
  const rows: CapabilityMatrixRow[] = [];

  for (const mode of modes) {
    for (const surface of surfaces) {
      const reachable = surfaceReachesMode(surface, mode);
      for (const runtime of runtimes) {
        if (!reachable) {
          rows.push({ mode, runtime, surface, cell: "correctly-unavailable", reason: surfaceUnreachableReason(surface, mode) });
          continue;
        }
        if (runtime === "winter-agent") {
          // Every mode since Phase 8b runs on the Winter leg (Task 17: "the engine is retired;
          // every mode runs on the Winter leg") — the ONLY question left is surface reachability,
          // already settled above.
          const reason = mode === "chat"
            ? `the Winter leg serves every mode (Task 17) — reachable from this surface; ${CHAT_MODE_TOOL_NOTE}`
            : "the Winter leg serves every mode (Task 17) — reachable from this surface";
          rows.push({ mode, runtime, surface, cell: "implemented", reason });
          continue;
        }
        // runtime === "claude-agent"
        rows.push({ mode, runtime, surface, cell: "correctly-unavailable", reason: OFFICIAL_LEG_RETIRED_REASON });
      }
    }
  }

  return { schema: 1, generatedBy: "packages/core/scripts/capability-matrix.ts", rows };
}

if (import.meta.main) {
  const matrix = buildCapabilityMatrix();
  const outPath = join(import.meta.dir, "..", "capability-matrix.json");
  writeFileSync(outPath, JSON.stringify(matrix, null, 2) + "\n");
  console.log(`wrote ${matrix.rows.length} rows to ${outPath}`);
}
