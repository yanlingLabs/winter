/**
 * 2026-09-19: the DERIVED half of an internal-jobs role's `problem` field.
 *
 * `role-health.ts`'s `RoleHealthRegistry` records what a call actually DID (a rate limit, a rejected
 * credential, an unavailable model) and persists it to `<home>/runtimes/role-health.json`. The two
 * reasons this module produces are a different kind of fact entirely: they are STRUCTURAL — "this role
 * is not running, and it never will until you change something" — and they are recomputed from the live
 * view on every read.
 *
 * SO THEY ARE NOT PERSISTED, deliberately, and the decision is worth spelling out because
 * `role-health.json` exists right beside it. A recorded failure has to survive a restart: the call that
 * produced it will not repeat until the next dream cycle (hours), so without the file the note would
 * vanish and the user would never see why. A structural refusal is the opposite — it is re-derivable in
 * a microsecond from settings + the credential snapshot, and a persisted copy could only ever be STALE:
 * the moment the user stores a key, a written `no-internal-credential` note would have to be found and
 * deleted by something, and anything that forgets to is a note about a problem that no longer exists.
 * `problemFor`'s own doc comment already names that as "exactly the noise this field exists to avoid".
 * Derived state clears itself by construction; that is the whole reason to derive it.
 *
 * THE REVIEWER'S FALLBACK: `reviewer.model` is a SAFETY gate, so an unrunnable pin does not switch it off
 * — it runs on the default rule's answer instead (`ResolveOptions.fallbackToDefault`). The role still
 * reports the pin's own problem, because the pin is what the user has to fix; the `detail` gains a
 * "meanwhile" clause naming the tag actually reviewing, so the pane never implies the gate is down.
 *
 * PRECEDENCE: a structural problem WINS over a recorded one. A persisted "rate-limited" note about a
 * model the role cannot even reach any more is misleading — the user's problem is the credential, not
 * the rate limit — and the recorded note is left untouched underneath, so it comes back the moment the
 * role is runnable again (the same "left underneath in case the role moves BACK" rule `problemFor`
 * already follows for a model change).
 */
import type { ModelRole, Settings } from "../settings";
import { isInternalJobRole } from "../settings";
import type { RoleProblem } from "./role-health";
import { isInternalRefusal, type InternalRouter } from "./internal-router";

/**
 * Overlays the structural problem onto a `modelRolesFor` result that has already been through
 * `withProblemsForRoles`. `router` absent (every pre-2026-09-19 caller/test, and the deliberately
 * provider-less boot) returns the input untouched.
 *
 * `at` is the view's `changedAt()`, not `Date.now()`: the Mac's Roles pane polls this RPC, and a
 * timestamp that moved on every read would make the Notes section flicker a new "as of" on a condition
 * that has not changed since boot.
 *
 * `model` is the role's own effective tag when it has one, and `""` when it does not — `RoleProblem.model`
 * is a required string on the wire, and the ONE consumer of it (`problemFor`'s currency comparison)
 * never runs for a derived problem.
 */
export function internalRoleProblemsFor<T extends { model: string | null; problem: RoleProblem | null }>(
  roles: Record<ModelRole, T>,
  settings: Settings | null | undefined,
  router: InternalRouter | undefined,
): Record<ModelRole, T> {
  if (router === undefined) return roles;
  const at = router.view.changedAt();
  const out = {} as Record<ModelRole, T>;
  for (const role of Object.keys(roles) as ModelRole[]) {
    const info = roles[role];
    if (!isInternalJobRole(role)) {
      out[role] = info;
      continue;
    }
    // `reviewer.model` is asked with the SAME `fallbackToDefault` the reviewer itself uses, so the pane can
    // never report a state the running job is not in (user ruling 2026-09-19).
    const resolved = router.resolve(role, settings, role === "reviewer.model" ? { fallbackToDefault: true } : undefined);
    if (isInternalRefusal(resolved)) {
      out[role] = { ...info, problem: { reason: resolved.reason, detail: resolved.detail, model: resolved.tag ?? "", at } };
      continue;
    }
    // A LIVE call that still has something to report: the reviewer's explicit pin was unrunnable and it
    // fell back. The problem is about the PIN — its reason, its tag — with a "meanwhile" clause naming
    // what is actually reviewing, so the user knows the safety gate did NOT switch itself off.
    out[role] = resolved.pinRefusal === undefined
      ? info
      : {
          ...info,
          problem: {
            reason: resolved.pinRefusal.reason,
            detail: `${resolved.pinRefusal.detail} — reviewing on ${resolved.tag} meanwhile`,
            model: resolved.pinRefusal.tag ?? "",
            at,
          },
        };
  }
  return out;
}
