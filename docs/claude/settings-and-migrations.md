# Settings and migrations

*Read before adding a setting or touching the legacy-home/project migration. Paths are under `packages/core/src/` unless stated.*

## Live settings
- `<WINTER_HOME>/settings.json` is watched by `settings-watcher.ts` (debounced, single-flight, keep-last-good on a torn file) and swapped atomically by `settings-apply.ts`; read live getters, never a boot snapshot.
- **No setting or credential change may ever need a daemon restart.** A live child keeps its spawn-time `Options` until its next incarnation; only a credential write evicts children ([providers](./providers-and-credentials.md)).
- A new setting is an `.optional()` block whose default lives in ONE reader (`settings.ts`: `pinsFor`, `providerBaseUrlFor`, `legacyProjectFilesReadEnabled`, `winterOptionsFromSettings`); an absent block never materializes zod's per-key defaults.
- `usage` (`usageTrackingFrom`): whether Winter may read the user's own Codex / Claude Code / OpenCode usage and Antigravity plan — [usage](./usage.md).
- Permissions, `outputStyle`, memory, plugins and `mcpServers` live in `<home>/sdk`: [runtime-home](./runtime-home.md). Retired `runtimes.claudeExecutable`/`official.*`/`handoff.crossRuntime` parse, are ignored and logged once per change of the set (`retiredRuntimeSettingKeys`).

## Migration B (legacy home)
- First boot copies `~/.norma[-dev]` into a PRISTINE `~/.winter[-dev]` (`isPristineHome`) before anything else is created: `migration/migrate-b.ts` `planMigrationB`/`runMigrationB`, ONLY on the profile's default home (`winter-dir.ts` `isDefaultWinterHome`); any other home logs one line and needs `winter migrate --from <dir>`.
- Byte-for-byte except the disposable set (`run/**`, `logs/**`, `cache/**`, `daemon.log`, `*.db-wal`/`*.db-shm`; `index.db` is rebuilt) and `settings.json`, re-keyed by `migration/rekey-settings.ts` (legacy env-var names and `~/.norma[-dev]` segments in string values; keys never renamed).
- Keychain items in `auth/legacy-secret-names.ts` `MIGRATION_B_SECRET_NAMES` copy from the legacy service, never over an existing item.
- Cowork storage is never copied (`migration/cowork-exclusion.ts`): `cowork/**` classifies as skipped, `planMigrationB`/`resumeMigrationB` refuse with `cowork_storage_present` when the source holds a Cowork tree or a populated Cowork table in its `runtime-state.db` (inspected through a private copy, never in place), the executor and rollback each refuse Cowork paths independently, and the daemon's boot hook logs one skip line rather than refusing to boot. [cowork.md](./cowork.md#storage-lifecycle-records-and-guards-only).
- `<home>/migration/manifest.json` is written atomically per step; a half-migrated home refuses boot `home_half_migrated` until `--resume`/`--rollback` (never auto-resumed). CLI: `winter migrate [--from <dir>] [--status|--resume|--rollback] [--yes]` (`packages/cli/src/commands/migrate.ts`).

## Runtime-state schema v18 and the way back
- `runtimes/runtime-state.db` is at schema v18 (`RUNTIME_STATE_SCHEMA_VERSION`). Migration 18 (`rebuildsParentTable`) rebuilds `cowork_conversations` and adds `cowork_home_binding`; every daemon runs the whole ladder on upgrade, Cowork or not. The tables stay empty in production (nothing writes a Cowork row; pinned by `test/cowork/rollback-normal-user.test.ts`).
- **Rollback is one-way without one step.** An older Winter (0.124.0, schema v7) that meets a v18 store reports `newer-schema` and refuses EVERY session (`winter_leg_unavailable`). To go back: stop the daemon, run `winter migrate --cowork-schema --rollback` with the NEWER Winter's CLI (`downgradeCoworkRuntimeStateToV7`, accepts v8..v18; it drops the empty Cowork tables and sets v7), THEN install the older app. The command refuses with `cowork-data-present` only if a Cowork table holds a row, which a normal user never has. A revert release reverts the FEATURE, never the schema.
- `winter doctor` on a newer-schema store says the same (the finding text names the command); an older build cannot say it, which is why the release notes carry it.

## Legacy projects
- `winter migrate-project [dir] [--yes]` (`migration/project-files.ts`): `NORMA.md`/`.norma/` to `WINTER.md`/`.winter/` (`git mv` when tracked, content untouched); repo-root `.mcp.json` to `.winter/mcp.json`; old permission answers to `.winter/settings.local.json`.
- Until then the legacy instructions file, rules, output styles and settings are read READ-ONLY where the Winter path is absent (`legacy.readLegacyProjectFiles`, default on; `agent/legacy-project-files.ts`), with one deprecation notice in the system context.
- `winter doctor` reports migration status and a COUNT (never names or values) of leftover legacy Keychain items, probed for presence only (`migration/legacy-keychain-store.ts` `legacyKeychainPresence`: no data request, so no consent dialog).
