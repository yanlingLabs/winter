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
 * THE INCARNATION-END DISPOSAL RULE (spec §3.8, r3), one function for both legs:
 *  - `safe` → the router reconciled (or there was nothing to reconcile) — dispose the folder;
 *  - `quarantined` → the router already copied the working copy to `<home>/cache/quarantine/` —
 *    the folder is disposable too;
 *  - `pending`/unknown → KEEP it: an exit the router has not settled is recovery's to reconcile
 *    (`reconcileRootForRecovery` at the next boot), never a delete here.
 * `winterLegSafe`: the Winter leg writes the canonical store directly and has no working copy, so a
 * router that cannot answer (no outcome door) still makes its run home safe by construction; the
 * official leg is never disposed without an answer.
 */
export async function settleRunHome(
  runHome: RunHome,
  outcome: RunHomeOutcome | undefined,
  opts: { winterLegSafe: boolean; log?: (line: string) => void },
): Promise<"disposed" | "kept"> {
  const effective = outcome ?? (opts.winterLegSafe ? "safe" : "pending");
  if (effective === "pending") {
    opts.log?.(`run home ${runHome.runId} kept: the router has not settled its exit (recovery reconciles it)`);
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
