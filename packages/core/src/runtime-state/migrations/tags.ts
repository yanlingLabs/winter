// WS-20 (spec §5, "per-session/runtime-state rows"): rewrites `runtime_sessions.model_ref` and
// `runtime_children.model_ref` from a bare legacy model id to a provider-qualified `ModelTag`.
//
// Runs the SAME way `backfillNativeSessions` does (idempotent, at every boot, wired alongside it
// in `runtime-state/wiring.ts`) rather than through the DDL ladder in `db.ts` — this is a DATA
// rewrite, not a schema change, and re-running it after it has already converted every row is a
// cheap no-op (every already-tag-shaped `model_ref` is skipped).
//
// THE RULE: a row's OWN `provider_id` already says which provider the session ran on, so this
// trusts it directly (`${catalogProviderId}/${modelRef}`) rather than disambiguating through the
// full multi-provider "S" rule `migrateBareModelId` uses for settings fields — that rule is the
// fallback ONLY for a `provider_id` this daemon does not recognise as a pinned catalog provider
// (e.g. a stale, pre-migration id). `openai-compatible` maps to `openai`, matching the settings
// migration's own provider-type mapping.
//
// A bare id of literally `"unknown"`/`"unstated"` (the pre-WS-20 sentinels, see
// `runtime-sdk/messaging.ts`) is never treated as a real model — it becomes `UNSTATED_TAG`
// directly, never `"<provider>/unknown"`.
import { isModelTag, UNSTATED_TAG, type ModelTag } from "../../runtime-sdk/model-tag";
import { migrateBareModelId } from "../../settings";
import type { RuntimeStateDb } from "../db";

const LEGACY_UNSTATED_BARE_IDS: ReadonlySet<string> = new Set(["unknown", "unstated"]);

/** Resolves ONE row's bare `model_ref` to a tag, given the row's own `provider_id`. Exported for
 *  `sessions/store.ts`'s parallel `sessions.model` rewrite, which follows the identical rule. */
export function tagForLegacyModelRef(modelRef: string, providerId: string, home: string): ModelTag {
  if (isModelTag(modelRef)) return modelRef as ModelTag; // already migrated, or a winter-test double
  if (LEGACY_UNSTATED_BARE_IDS.has(modelRef)) return UNSTATED_TAG;
  const catalogProviderId = providerId === "openai-compatible" ? "openai" : providerId;
  const candidate = `${catalogProviderId}/${modelRef}`;
  if (isModelTag(candidate)) return candidate as ModelTag; // the row's own provider is trusted directly
  // The row's provider_id is not a catalog provider this daemon recognises — fall back to the
  // generic multi-provider disambiguation rule (spec §5 rules 4/5), same as a settings field.
  return (
    migrateBareModelId(modelRef, { fieldName: "runtime-state.model_ref", home, emptySFallback: UNSTATED_TAG }) ??
    UNSTATED_TAG
  );
}

export interface ModelRefMigrationReport {
  sessionsRewritten: number;
  childrenRewritten: number;
}

/** Rewrites every non-tag-shaped `model_ref` in `runtime_sessions` and `runtime_children` in
 *  place. Idempotent (a row already holding a tag, or the sentinel, is never re-written) and safe
 *  to call on every boot, exactly like `backfillNativeSessions`. */
export function migrateModelRefsToTags(deps: { rs: RuntimeStateDb; home: string }): ModelRefMigrationReport {
  const { rs, home } = deps;
  const report: ModelRefMigrationReport = { sessionsRewritten: 0, childrenRewritten: 0 };
  rs.transaction(() => {
    const sessionRows = rs.db
      .query<{ winter_session_id: string; provider_id: string; model_ref: string }, []>(
        "SELECT winter_session_id, provider_id, model_ref FROM runtime_sessions",
      )
      .all();
    for (const row of sessionRows) {
      if (isModelTag(row.model_ref)) continue;
      const tag = tagForLegacyModelRef(row.model_ref, row.provider_id, home);
      rs.db.query("UPDATE runtime_sessions SET model_ref = ? WHERE winter_session_id = ?").run(tag, row.winter_session_id);
      report.sessionsRewritten++;
    }
    const childRows = rs.db
      .query<{ parent_winter_session_id: string; child_id: string; provider_id: string; model_ref: string }, []>(
        "SELECT parent_winter_session_id, child_id, provider_id, model_ref FROM runtime_children",
      )
      .all();
    for (const row of childRows) {
      if (isModelTag(row.model_ref)) continue;
      const tag = tagForLegacyModelRef(row.model_ref, row.provider_id, home);
      rs.db
        .query("UPDATE runtime_children SET model_ref = ? WHERE parent_winter_session_id = ? AND child_id = ?")
        .run(tag, row.parent_winter_session_id, row.child_id);
      report.childrenRewritten++;
    }
  }, { mode: "immediate" });
  return report;
}
