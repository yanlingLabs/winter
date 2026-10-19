# Cowork landing fixes (review of the first inert landing)

Fixes for the review findings on the first landing PR, made on integration so the next landing snapshot carries them.

## Inert at runtime
- `cowork/workspace-events.ts`: `start({ keepAlive })` runs one guarded drain, then arms the 1 s timer ONLY when a Cowork host was injected (`opts.coworkHost` or a native environment, never in production) or events are still pending. The tick is guarded, logs one line (a code, never a message), and stops itself once nothing is owed unless `keepAlive`. `drain()`'s outer pending-sessions query is caught.
- `cowork/folder-selections.ts`: the sweep timer is armed by the first selection and cleared when the table empties; a daemon that never prepares a folder owns no timer.
- `daemon.ts`: `schedules.recover()`, `schedules.tick()` and the native boot reconcile are each wrapped; a throw logs one short line and startup continues.
- Tests: `test/cowork/boot-quiet.test.ts` (no Cowork `setInterval` on a production-shaped daemon; a throwing boot step does not abort startup), plus unit tests in `workspace-events.test.ts` and `folder-selections.test.ts`. Mutation-checked: always-arm, constructor-arm, unguarded tick and unguarded timer tick each fail a named test.

## Hygiene
Two committed logs carried a machine-specific temp path and are removed (nothing referenced them). The identity scan should also count the per-user temp-dir shape `/var/folders/<2>/<id>/T`.

## Start-up cost
`runtime-sdk/host-code-broker.ts` no longer imports `@yanlinglabs/winter-agent-runtime` at module load; the SDK adapter probe loads it on first use (`require`), and `HostCodeExecutionService` resolves its adapter lazily. Measured on module load of `runtime-sdk/create`: about 17 MB RSS and 60 ms less. Probe behaviour is unchanged.

## Messaging and the phone
- `agent/session-messaging.ts`: a failure reading the Cowork tables degrades only rows that claim `mode: "cowork"`; Code and Dispatch rows stay listed and reachable. Trade-off, stated plainly: while the tables are unreadable a row whose stored mode is not `cowork` cannot be cross-checked against a canonical binding, so the stale-index downgrade guard is suspended for that window. No Cowork session can exist in production.
- `ipc/server.ts` (phone stream): a failing per-event scope lookup skips that event and keeps the connection (it used to drop the phone).

## Migration
- `migration/cowork-exclusion.ts`: a `cowork/` directory holding only OS litter (`.DS_Store`, `._*` AppleDouble files, `.localized`) is not Cowork storage; any other entry still is. Litter is written by Finder into any folder a user has opened and carries no workspace data.
- A database that cannot be opened as SQLite stays fail-closed (a corrupt file could hide Cowork records). A zero-byte file already reads as "no tables".
- The boot-skip message for an uninspectable legacy entry no longer tells the operator to move it aside (the legacy home is the rollback source); it says nothing was changed and the check repeats at every start.

## Mac and CLI
- The Cowork row shows the placeholder while `SessionMode.cowork.isAvailable` is false, even with a management connection (`SessionMode.coworkDetail`), so no folder picker is reachable from a "Soon" row.
- `winter --help` no longer lists `workspace|project`; the commands still route and refuse.
