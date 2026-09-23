// WS-21: does the LINKED router apply per-run homes (Contract A)?
//
// The whole of WS-21's runtime-facing behaviour hangs on this one fact, because two binaries the
// daemon does not control decide where the runtime-facing files actually are:
//
//  - the router's shared transcript store (router 0.0.11: `<home>/projects`; a run-home router:
//    `sdkHomeOf(home)/projects`), and
//  - the Winter child's own store and agent scan (agent SDK 0.0.20 under `WINTER_HOME=<home>`:
//    `<home>/projects`, `<home>/agents`; a run-home child under `WINTER_STORE_HOME`: `<home>/sdk/…`).
//
// Both stores write through `ensureSecureDir`, which REFUSES a symlink at `<store>/projects` — so the
// daemon cannot bridge the two layouts with a compatibility link. It follows the runtimes instead:
// until the linked router exports `buildRunHome`, every runtime-facing path stays exactly where it is
// today (C2, "defaults dropped too early"), and no child can ever be spawned on a layout it does not
// write.
//
// This is a property of the BUILD (which router package is linked), not of a daemon instance, so it
// is read from the module namespace once and cached. Tests pin either answer with the seam below and
// must restore it.
import * as routerModule from "@yanlinglabs/winter-runtime-sdk";
import type { RouterRunHomeHandle, RunHome, RunHomeInput, RunHomeOutcome } from "./run-home-contract";

/** True when `router` (a module namespace or any object) exports a callable `buildRunHome`. */
export function routerSupportsRunHome(router: unknown): router is { buildRunHome: (i: RunHomeInput) => Promise<RunHome> } {
  return typeof router === "object" && router !== null && typeof (router as { buildRunHome?: unknown }).buildRunHome === "function";
}

/** The LINKED router's `buildRunHome`, or `undefined` when it does not export one (router 0.0.11).
 *  Deliberately NOT affected by `setRunHomeSupportForTests`: a test that wants a builder injects a stub
 *  through the session driver's deps; the production wiring never has one it cannot call. */
export function linkedRunHomeBuilder(): ((input: RunHomeInput) => Promise<RunHome>) | undefined {
  const linkedModule: unknown = routerModule;
  if (!routerSupportsRunHome(linkedModule)) return undefined;
  const build = linkedModule.buildRunHome;
  return (input) => build(input);
}

/** A router handle's run-home members, when it has them (a run-home router's `createRuntimeSdk`). */
export function runHomeHandleOf(sdk: unknown): RouterRunHomeHandle | undefined {
  if (typeof sdk !== "object" || sdk === null) return undefined;
  const h = sdk as Partial<RouterRunHomeHandle>;
  return typeof h.runHomeOutcome === "function" && typeof h.reconcileRootForRecovery === "function" ? (h as RouterRunHomeHandle) : undefined;
}

/**
 * THE INCARNATION-END DISPOSAL RULE (spec §3.8, r3; L2 fix round 1), one function for both legs: dispose
 * ONLY when the router says `safe` — on the official leg its exit reconcile found the working copy clean
 * (or appended it); on the Winter leg the query finished, was closed or failed (it reports `pending`
 * while the child runs, and for a query nobody iterated). Everything else KEEPS the folder:
 *  - `quarantined` → the router copied the working copy under `<home>/cache/quarantine/`; the folder is
 *    kept and handed to `onQuarantined` (the daemon records it, so the boot sweep never re-reconciles
 *    it and `winter doctor` reports it);
 *  - `pending` / no answer → recovery's to reconcile at the next boot (`reconcileRootForRecovery`),
 *    never a delete here.
 * A query that threw before it was created records nothing: that open disposes through
 * `disposeFailedRunHome` instead.
 */
export async function settleRunHome(
  runHome: RunHome,
  outcome: RunHomeOutcome | undefined,
  opts: { log?: (line: string) => void; onQuarantined?: (dir: string) => void } = {},
): Promise<"disposed" | "kept"> {
  if (outcome !== "safe") {
    if (outcome === "quarantined") {
      try { opts.onQuarantined?.(runHome.dir); } catch { /* bounded: the record is evidence, never a dependency */ }
      opts.log?.(`run home ${runHome.runId} kept: the router quarantined its working copy (see \`winter doctor\`)`);
    } else {
      opts.log?.(`run home ${runHome.runId} kept: the router has not settled its exit (recovery reconciles it)`);
    }
    return "kept";
  }
  try {
    await runHome.dispose();
  } catch (err) {
    opts.log?.(`run home ${runHome.runId} could not be disposed (${(err as Error)?.name ?? "error"}) — the boot sweep retries`);
    return "kept";
  }
  return "disposed";
}

/**
 * What a run home's builder did NOT do, as one log line (spec §8: surfaced, never silent) — every
 * `RunHome.report` field, `skippedAgents` included (L2 fix round 1). Paths, server names and reasons
 * only. `undefined` for a report with nothing in it.
 */
export function runHomeReportSummary(runHome: RunHome): string | undefined {
  const r = runHome.report;
  const parts: string[] = [];
  if (r.skippedLinks.length > 0) parts.push(`skipped links: ${r.skippedLinks.map((l) => `${l.path} (${l.reason})`).join(", ")}`);
  if (r.externalUserLinks.length > 0) parts.push(`links outside the shared home: ${r.externalUserLinks.join(", ")}`);
  if (r.droppedMcpServers.length > 0) parts.push(`MCP servers dropped: ${r.droppedMcpServers.map((m) => `${m.name} (${m.reason})`).join(", ")}`);
  if (r.unconditionalRules.length > 0) parts.push(`rules without paths (always loaded): ${r.unconditionalRules.join(", ")}`);
  if (r.droppedImports.length > 0) parts.push(`@imports dropped (outside the project): ${r.droppedImports.join(", ")}`);
  const skippedAgents = r.skippedAgents ?? [];
  if (skippedAgents.length > 0) parts.push(`agents not copied: ${skippedAgents.map((a) => `${a.path} (${a.reason})`).join(", ")}`);
  return parts.length === 0 ? undefined : `run home ${runHome.runId}: ${parts.join("; ")}`;
}

/** A run home whose open FAILED is disposed at once (spec §3.8 r3: nothing ran on it). Never throws. */
export async function disposeFailedRunHome(runHome: RunHome | undefined, log?: (line: string) => void): Promise<void> {
  if (runHome === undefined) return;
  try { await runHome.dispose(); } catch (err) {
    log?.(`run home ${runHome.runId} of a failed open could not be disposed (${(err as Error)?.name ?? "error"}) — the boot sweep retries`);
  }
}

const linked: boolean = routerSupportsRunHome(routerModule);
let testOverride: boolean | undefined;

/** Whether the router package this daemon was built against applies run homes. */
export function linkedRouterSupportsRunHome(): boolean {
  return testOverride ?? linked;
}

/** TEST ONLY: pin `linkedRouterSupportsRunHome()` (`undefined` restores the linked answer). A test
 *  that sets it must restore it in a `finally`/`afterEach`. */
export function setRunHomeSupportForTests(value: boolean | undefined): void {
  testOverride = value;
}
