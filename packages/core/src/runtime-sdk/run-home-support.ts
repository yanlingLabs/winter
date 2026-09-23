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

/** The minimal shape the daemon feature-detects. L3.3 narrows the parameter and result to Contract A's
 *  `RunHomeInput`/`RunHome` (`run-home-contract.ts`). */
export interface RouterWithRunHome {
  buildRunHome: (input: never) => Promise<unknown>;
}

/** True when `router` (a module namespace or any object) exports a callable `buildRunHome`. */
export function routerSupportsRunHome(router: unknown): router is RouterWithRunHome {
  return typeof router === "object" && router !== null && typeof (router as { buildRunHome?: unknown }).buildRunHome === "function";
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
