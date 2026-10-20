# Runtime-state schema v18 (Cowork tables) - release note draft

Draft line for the release that first carries the Cowork integration (Cowork itself stays off):

> Winter's local database (`runtimes/runtime-state.db`) moves to schema v18 on first launch. Going back to an older Winter afterwards needs one step first: quit Winter, run `winter migrate --cowork-schema --rollback` with this version's command-line tool, then install the older app. Skipping the step makes the older Winter refuse to open your sessions until the database is rolled back.

Facts for the writer: the rollback accepts v8 to v18 and drops only empty Cowork tables (it refuses with `cowork-data-present` if one has a row, which no production build can write); nothing else in the database changes. See `docs/claude/settings-and-migrations.md` (Runtime-state schema v18 and the way back).
