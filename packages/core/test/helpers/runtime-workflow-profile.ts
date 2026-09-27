// WS-27 review, re-pinned for SDK 0.0.33: the RUNTIME's workflow-worker seatbelt profile.
//
// An embedded session's Workflow tool is spawned by the runtime (`@yanlinglabs/winter-agent-runtime`), under
// the runtime's own `buildWorkflowWorkerSeatbeltProfile` — which the package now exports directly (0.0.33),
// so this just calls it with no run-directory read-denies (the only thing `opts.home`/`opts.winterHome`
// would add, and they only ever narrow the profile), for a byte comparison with core's own builder.
import { buildWorkflowWorkerSeatbeltProfile } from "@yanlinglabs/winter-agent-runtime";

/** The runtime's worker profile for `selfExecPath`, without its optional run-directory read-denies. */
export function renderRuntimeWorkflowProfile(selfExecPath: string): string {
  return buildWorkflowWorkerSeatbeltProfile(selfExecPath, { home: undefined });
}
