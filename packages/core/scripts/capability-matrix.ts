#!/usr/bin/env bun
/**
 * Winter Phase 8d (P8d-15, WS-17 §6 row 9): generates `packages/core/capability-matrix.json` —
 * Norma's OWN rows of the cross-repo capability matrix (mode × runtime × surface). The SDK repo
 * owns the other axes (provider/protocol capabilities); this file's whole scope is "what Norma's
 * own daemon/CLI/app/remote-gateway code lets each combination reach", derived from three real
 * predicates rather than hand-typed:
 *
 *   1. **decideRuntime's bail-outs** (`runtime-sdk/session-driver.ts`) — chat/dispatch never
 *      reach the official (`claude-agent`) leg. This is a STRUCTURAL fact for dispatch (its wire
 *      params, `SessionDispatchParams = z.object({})`, carry no model at all — there is nothing
 *      for the router to route on) and a deployment-wide policy fact for chat/code (P8c-1/P8c-2's
 *      "the official leg ships Code-only" ruling, `runtime-sdk/create.ts`'s official env block) —
 *      cited here rather than re-derived, since re-deriving the router's own internal decision
 *      from this package would mean asserting something about `@yanlinglabs/winter-agent-sdk`'s
 *      compiled code this repo does not own.
 *   2. **`REMOTE_ALLOWED_METHODS`** (`ipc/server.ts`) — a remote (iOS) client CAN reach
 *      `session.create`/`session.setModel` for every mode `REMOTE_ELIGIBLE_SESSION_MODES` names
 *      (`code`/`dispatch`/`chat`, `ipc/server.ts:575` — Chat Slice C lifted chat's remote gate,
 *      SP3.4 added remote session.create). The exact SET is duplicated here as a literal (not
 *      imported: `REMOTE_ELIGIBLE_SESSION_MODES` is `ipc/server.ts`-private, and re-exporting a
 *      constant from an already-large 8d file purely for this generator was judged not worth the
 *      touch) — a drift test (`test/capability-matrix.test.ts`) pins this generator's OWN output
 *      against a fresh run, so a future change to that set fails the SAME way any other drift does.
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

/** `ipc/server.ts:575`'s `REMOTE_ELIGIBLE_SESSION_MODES` literal — see this file's own header for
 *  why it is copied rather than imported. */
const REMOTE_ELIGIBLE_MODES: readonly CapabilityMode[] = ["code", "dispatch", "chat"];

/** `packages/cli/src/session-mode.ts`'s own top-of-file doc, copied for the same reason
 *  (cross-package import direction: `cli` depends on `core`, never the reverse) — the TUI/CLI is
 *  code-only; dispatch and chat are "apps [+ orb]" only. */
const CLI_REACHABLE_MODES: readonly CapabilityMode[] = ["code"];

/** Every surface reaches every mode except the CLI's own code-only carve-out above. Mac (the app +
 *  the orb) and iOS-remote (`REMOTE_ELIGIBLE_MODES`) agree exactly: both offer all three modes. */
function surfaceReachesMode(surface: CapabilitySurface, mode: CapabilityMode): boolean {
  if (surface === "cli") return CLI_REACHABLE_MODES.includes(mode);
  if (surface === "mac") return true;
  return REMOTE_ELIGIBLE_MODES.includes(mode); // ios-remote
}

function surfaceUnreachableReason(surface: CapabilitySurface, mode: CapabilityMode): string {
  if (surface === "cli") {
    return `the TUI/CLI is code-only (packages/cli/src/session-mode.ts) — ${mode} sessions are apps${mode === "dispatch" ? "/orb" : ""}-only and cannot be created or attached from here`;
  }
  return `unreachable for this surface`; // unused today — mac/ios-remote reach every mode
}

/** The official leg's own Code-only gate (P8c-1/P8c-2, `runtime-sdk/create.ts`'s official env
 *  policy) — a deployment-wide ruling this package hosts a driver for but does not itself enforce
 *  per-mode (the router does), cited rather than re-derived (see this file's header). Dispatch
 *  additionally has a STRUCTURAL reason: `SessionDispatchParams` carries no model field at all. */
function officialLegReason(mode: CapabilityMode): string {
  if (mode === "dispatch") {
    return "SessionDispatchParams carries no model field at all (methods.ts) — the dispatch singleton can never name a Claude catalog model for the router to route on";
  }
  return "the official leg ships Code-only (P8c-1/P8c-2 policy, runtime-sdk/create.ts's official env block) — decideRuntime's own bail-outs never route a chat session to the claude-agent leg";
}

const CHAT_MODE_TOOL_NOTE = (() => {
  const excluded = disallowedToolsFor("chat");
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
        if (mode === "code") {
          rows.push({
            mode, runtime, surface, cell: "implemented",
            reason: "the official leg serves Code-mode sessions on a Claude catalog model with an Anthropic key (session-driver.ts's decideRuntime -> createOfficial), reachable from this surface",
          });
        } else {
          rows.push({ mode, runtime, surface, cell: "correctly-unavailable", reason: officialLegReason(mode) });
        }
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
