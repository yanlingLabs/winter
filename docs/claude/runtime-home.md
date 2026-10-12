# Runtime home

*Read before touching `<home>/sdk`, run folders, MCP/settings scopes, saved answers, plugins or Migration C. Paths are under `packages/core/src/` unless stated.*

## `<home>/sdk`
- The one durable claude-format config dir and the runtimes' store (`storeHomeFor`, `agent/paths.ts`); `<home>/cache/runs/<id>` is a disposable per-run VIEW of it, never a second copy of record.
- `sdk/settings.json`: `permissions.allow`/`deny`/`additionalDirectories`, `outputStyle`, `autoMemoryEnabled`/`autoMemoryDirectory`, `enabledPlugins`. `sdk/.winter.json`: `mcpServers` (user scope), `projects[<root>].mcpServers` (local scope, the `mcp add` default); a trusted project's `.winter/mcp.json` is project scope; precedence local > project > user; the repo-root `.mcp.json` is not read ([mcp](./mcp.md)).
- Project-named scopes key on `gitRootFor(cwd)` (`runtime-sdk/run-home-input.ts`: a linked worktree's OWN top, never the main checkout `repoRootFor` follows it to); TRUST alone keys on `repoRootFor` (`projectScopeTrusted`), so a worktree of a trusted repo is trusted.
- Read only via `settings.ts`'s `sdk…` readers (`liveSettingsView` strips the keys from every live holder); write only via `sdk-files.ts` (atomic, 0600, never over a file that does not parse).
- The settings split (`migration/settings-split.ts` `SPLIT_KEYS`) copies each key once (per-key marker AND sdk-key-absent) at every boot on every home, never writing `settings.json`; the plugin pair (`plugins.enabled/disabled` to `enabledPlugins`) is the plugin conversion's.

## Run homes
- The pinned router (0.0.16) exports `buildRunHome`, so run homes always apply; `runtime-sdk/run-home-support.ts` `linkedRouterSupportsRunHome` is feature detection (its test seam `setRunHomeSupportForTests` must be restored in `finally`).
- Each incarnation awaits `<home>/cache/runs/<id>` (`runHomeInputFor`), built LAST in `session-driver.ts` `optionsFor` so a refusal leaves none behind. The daemon states NOTHING the folder carries: no `agents`/`plugins`/`skills`/`outputStyle`/`brand`, no saved allow rules, no project instructions/rules/output style, none of `mode-options.ts` `WINTER_ROUTER_OWNED_ENV`, and `settingSources: ["user"]`; the router refuses each typed, its `RunHomeError` code forwarded as `data.code`.
- The child's `$WINTER_HOME` is THAT run folder (torn down with it); `$WINTER_STORE_HOME` is the durable `<home>/sdk`; a hook or fence on `$WINTER_HOME` reads only the disposable copy.
- Dispose only when the router says `safe` (`settleRunHome`); a quarantined folder is kept and recorded in `run_root_quarantine` (`runtime-state/db.ts`, schema v7); a failed open disposes at once.
- Boot recovery (`runtime-state/root-recovery.ts` `recoverRunRoots`, late at the runtime-sdk site) reconciles recorded roots, leftover run folders and stale `claude-resume-*` roots through the router's `reconcileRootForRecovery` BEFORE deleting anything.

## Migration C (old layout to `sdk/`)
- `migration/migrate-c.ts`, for a home with real `projects/` or `skills/`: `MIGRATION_C_PHASE1` at the boot hook after the lock and settings load (preflight refuses BOOT on a live lease, an unexpected `sdk/`, an unreconcilable official working copy or unconvertible plugins; moved dirs leave relative compatibility links), `MIGRATION_C_PHASE2` at the late site through the router (official roots, transcript re-key, archive, done).
- Only the profile's default home migrates itself; another old-layout home refuses `sdk_home_migration_required` until `winter migrate --sdk-home [--home <dir>] [--resume|--rollback|--status] [--yes]` (daemon stopped); a half-migrated one refuses `sdk_home_half_migrated` until `--resume`/`--rollback`. `--status` is always allowed and never acts; `--rollback` never reverts what the user did after the upgrade.
- Stored model tags are never rewritten: `runtime-sdk/model-tag.ts` `canonicalModelTag` resolves a catalog rename ON READ (live settings view, runtime-state row decoders, `ModelTagSchema`'s transform), only when the old tag no longer resolves and the new one does.

## Saved answers
- `agent/saved-answers.ts`: "everywhere" to `sdk/settings.json`; "in this project" to the TRUSTED project's `<root>/.winter/settings.local.json` in claude's grammar (offered only then), after which `**/.winter/settings.local.json` joins the global git excludes (`agent/git-exclude.ts`).
- `<home>/permissions/projects.json` and `.winter/permissions.local.json` are READ-ONLY; `winter migrate-project` moves their entries into the project.
- `winter doctor` (`migration/sdk-home-doctor.ts`) reports Migration C, the split, untranslated rules, leftover approved-rules entries, quarantined roots and the last run-folder sweep.

## Plugins (claude's format)
- `skills/`, `.mcp.json`, `agents/`, `hooks/hooks.json` in the plugin dir, installed from a marketplace and keyed EVERYWHERE as `"<name>@<marketplace>"` (`installed_plugins.json`, consent records, `plugins/plugin-manager.ts` `setPluginEnabled`).
- `winter-plugin.json` is an optional Winter-only EXTRAS tier (`agent/plugin-manifest.ts`); absent or invalid, the plugin loads via the legacy `plugin.json`-only path with no manifest. A `contributes.{skills,mcpServers,agents,hooks}` key logs one notice and is ignored (claude's loader owns those); only declared extras gate on consent.
