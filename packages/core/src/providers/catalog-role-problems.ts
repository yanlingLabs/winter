/**
 * R.1 ruling 1 (WS-21): a role whose effective model is a tag the pinned catalog no longer carries.
 *
 * A catalog refresh can RETIRE a row outright. `CATALOG_TAG_RENAMES` covers a row that moved (a stored
 * `deepseek/deepseek-v4-flash` reads back as `deepseek/deepseek-flash`); a row with no documented
 * successor is left unmapped on purpose (V16: `deepseek/deepseek-reasoner`), and there is never a silent
 * fallback to another model. The write door already refuses such a tag (`setModelRole`: "no model in the
 * pinned catalog has the tag …"), but a tag STORED before the upgrade stays in `settings.json`, and the
 * Roles pane must say why that role cannot run rather than show it as healthy.
 *
 * So this is a DERIVED problem, like `internal-role-problems.ts`'s structural ones: recomputed from the
 * settings view and the linked catalog on every read, never persisted, cleared the moment the user picks
 * another model. It takes precedence over every other note — no credential or retry makes a retired row
 * runnable. `reason` is a raw string on the wire (`methods.ts`: "a new value reaches the UI with no
 * protocol change").
 *
 * Only a provider-qualified catalog namespace is judged: the harness doubles (`winter-test/*`) have no
 * catalog row by construction.
 */
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ModelRole } from "../settings";
import type { RoleProblem } from "./role-health";

/** The `problem.reason` for a role naming a model the linked catalog no longer carries. */
export const MODEL_NOT_IN_CATALOG = "model-not-in-catalog";

const TEST_NAMESPACE = "winter-test/";

let catalogKeys: ReadonlySet<string> | undefined;
let firstSeenAt: string | undefined;

function keys(): ReadonlySet<string> {
  catalogKeys ??= new Set(loadCatalog().models.map((m) => m.key));
  return catalogKeys;
}

/** Is `tag` a provider-qualified tag the linked catalog has no row for? */
export function isRetiredCatalogTag(tag: string): boolean {
  if (tag.startsWith(TEST_NAMESPACE) || !tag.includes("/")) return false;
  try {
    return !keys().has(tag);
  } catch {
    return false; // no catalog to judge by: say nothing rather than guess
  }
}

export function catalogRoleProblemsFor<T extends { model: string | null; problem: RoleProblem | null }>(
  roles: Record<ModelRole, T>,
): Record<ModelRole, T> {
  const out = {} as Record<ModelRole, T>;
  for (const role of Object.keys(roles) as ModelRole[]) {
    const info = roles[role];
    if (info.model === null || !isRetiredCatalogTag(info.model)) {
      out[role] = info;
      continue;
    }
    // A stable `at` (the first time this process derived one), so a polling pane does not flicker a new
    // "as of" on a condition that has not changed.
    firstSeenAt ??= new Date().toISOString();
    out[role] = {
      ...info,
      problem: {
        reason: MODEL_NOT_IN_CATALOG,
        detail: `${info.model} is no longer in this build's model catalog — pick another model for this role`,
        model: info.model,
        at: firstSeenAt,
      },
    };
  }
  return out;
}
