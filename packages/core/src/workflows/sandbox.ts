import { realpathSync } from "node:fs";

export { sandboxAvailable } from "../agent/sandbox";

/** Escape a path for an SBPL double-quoted literal (same as agent/sandbox.ts::sbplString). */
function sbplString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function canon(p: string): string { try { return realpathSync(p); } catch { return p; } }

/**
 * Tight Seatbelt (SBPL) profile for a workflow-worker subprocess. Strictly tighter than bash's:
 *   - deny file-write* EVERYWHERE (the child writes nothing — the journal is appended parent-side),
 *   - deny network*,
 *   - deny process-fork AND allow process-exec ONLY for the self binary.
 *
 * THE #1 RISK, verified empirically (see trackA-spike-notes.md): a blanket `(deny process-exec*)`
 * makes sandbox-exec's own execvp() of the target fail ("Operation not permitted"), because the
 * sandbox→target transition is itself an exec checked against the profile. So we allow exec of
 * EXACTLY `selfExecPath` (canonicalized) and nothing else — enough for bun to boot (it dyld-loads
 * its libs via the allowed file-read*), while a workflow script still cannot exec /bin/sh etc. Note
 * the operation is `process-fork` (NO star) — `process-fork*` is an unbound variable that fails to
 * load. The restricted mach-lookup set (identical to bash.ts) is sufficient for bun startup.
 */
export function buildWorkflowSeatbeltProfile(selfExecPath: string): string {
  const self = canon(selfExecPath);
  const machRules = [
    "com.apple.system.notification_center",
    "com.apple.system.logger",
    "com.apple.CoreServices.coreservicesd",
    "com.apple.bsd.dirhelper",
  ].map((s) => `  (global-name "${sbplString(s)}")`).join("\n");
  return `(version 1)
(deny default)
(allow process-exec (literal "${sbplString(self)}"))
(deny process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup
${machRules})
(allow file-read*)
(deny file-write*)
(deny network*)
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr"))
`;
}
