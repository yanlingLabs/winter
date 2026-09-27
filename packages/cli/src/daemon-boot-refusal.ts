// `winter daemon run`: a typed MIGRATION refusal from `startDaemon` is an operator message and a clean
// non-zero exit, never an uncaught-exception stack (P9c-17: under launchd KeepAlive a raw throw is a
// crash loop with a stack in daemon.log). Migration B's `MigrationRefused` and — WS-21 — Migration C's
// `MigrationCRefused` (`sdk_home_migration_required`, `sdk_home_migration_refused`,
// `sdk_home_half_migrated`) both land here.
import { CredentialMigrationBusy, MigrationCRefused, MigrationRefused } from "@yanlinglabs/winter-core";

/** WS-27: the exit code for "another process holds the credential migration lock" (`EX_TEMPFAIL`): the Mac
 *  app's DaemonSupervisor waits and retries with a back-off on this code instead of respawning at once. */
export const CREDENTIAL_MIGRATION_BUSY_EXIT_CODE = 75;

/** The process exit code for a typed boot refusal (`migrationRefusalMessage` names it). */
export function bootRefusalExitCode(err: unknown): number {
  return err instanceof CredentialMigrationBusy ? CREDENTIAL_MIGRATION_BUSY_EXIT_CODE : 1;
}

/** The message to print for a boot-time migration refusal, or `undefined` for any other error. */
export function migrationRefusalMessage(err: unknown): string | undefined {
  // WS-27: another process held the credential migration lock past the boot's bound — same posture.
  if (err instanceof MigrationRefused || err instanceof MigrationCRefused || err instanceof CredentialMigrationBusy) return err.message;
  return undefined;
}
