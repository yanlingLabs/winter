// WS-27 review: the daemon's Keychain pass, in two halves around the boot lock.
//
// `beginKeychainPass` runs before the first credential read (`credentialPresenceFrom`): it takes the credential
// migration lock — WAITING, bounded, while a live process holds it, and refusing the boot
// (`CredentialMigrationBusy`) if it never frees, so no boot ever reaches `ensureTokens` without its recovery —
// then runs the restore-only shadow recovery. `finishCredentialPass` runs after the boot lock and Migration B:
// the full recovery and the migration, which is skipped (recovery kept, no marker) when the keychain locked
// meanwhile or this process's designated requirement cannot be read — a marker is never keyed on a path.
import { codeSigningFacts, realExecutable } from "./app-token-acl";
import { prepareCredentialAccess, recoverCredentialShadows, runCredentialMigration, type CredentialAclOutcome, type CredentialKeychain } from "./credential-acl";
import { waitForCredentialMigrationLock, type CredentialMigrationLock } from "./credential-migration-lock";
import { keychainUnlocked, withKeychainUserInteractionDisabled, type KeychainAccess } from "./keychain-ffi";

export interface KeychainPass {
  lock: CredentialMigrationLock;
  kc: CredentialKeychain;
  access: KeychainAccess | undefined;
}

export interface BeginKeychainPassInput {
  home: string;
  service: string;
  log: (line: string) => void;
  /** Tests: stand-ins for the keychain status and the lock wait (never the real Keychain). */
  unlocked?: () => boolean;
  waitForLock?: (home: string) => Promise<CredentialMigrationLock>;
  kc?: CredentialKeychain;
}

/**
 * `undefined` when the keychain is locked (nothing can be read or restored; the boot goes on as before).
 * Throws `CredentialMigrationBusy` when the lock stays held — the caller lets it end the boot.
 */
export async function beginKeychainPass(input: BeginKeychainPassInput): Promise<KeychainPass | undefined> {
  const unlocked = input.unlocked ?? (() => keychainUnlocked(null));
  if (!unlocked()) {
    input.log("keychain: the default keychain is locked — no credential shadow pass this boot");
    return undefined;
  }
  const lock = await (input.waitForLock ?? ((h: string) => waitForCredentialMigrationLock(h, { log: input.log })))(input.home);
  // Anything that throws from here on must not leave the lock held by a process that will not finish.
  let access: KeychainAccess | undefined;
  try {
    const kc: CredentialKeychain = input.kc ?? { keychain: null, service: input.service, log: input.log };
    access = withKeychainUserInteractionDisabled(() => prepareCredentialAccess(kc));
    const built = access;
    withKeychainUserInteractionDisabled(() => recoverCredentialShadows(kc, built, { dropShadowsBesideOriginals: false }));
    return { lock, kc, access };
  } catch (err) {
    access?.release();
    lock.release();
    throw err;
  }
}

/** This process's designated requirement, or `undefined` when code signing cannot say (a failed or timed-out
 *  `codesign`). */
export function selfRequirement(): string | undefined {
  return codeSigningFacts(realExecutable(), 2_000).requirement;
}

/**
 * After the boot lock and Migration B, still under the credential migration lock: the full recovery and the
 * migration (`runCredentialMigration`), or — keychain locked meanwhile, requirement unreadable — the recovery
 * alone. Releases the access object; never throws; the caller releases the lock after the pairing tokens.
 */
export function finishCredentialPass(pass: KeychainPass, home: string, deps: { unlocked?: () => boolean; requirement?: () => string | undefined } = {}): CredentialAclOutcome | "skipped" {
  const { kc, access } = pass;
  try {
    if (!(deps.unlocked ?? (() => keychainUnlocked(null)))()) {
      kc.log?.("keychain: the default keychain locked during boot — the credential migration waits for the next boot");
      return "skipped";
    }
    const requirement = (deps.requirement ?? selfRequirement)();
    if (requirement === undefined) {
      kc.log?.("keychain: this process's designated requirement could not be read — shadow recovery only, the credential migration waits for the next boot");
      withKeychainUserInteractionDisabled(() => recoverCredentialShadows(kc, access, { dropShadowsBesideOriginals: true }));
      return "skipped";
    }
    return withKeychainUserInteractionDisabled(() => runCredentialMigration(kc, access, home, requirement));
  } catch (err) {
    kc.log?.(`keychain: the credential access lists were not updated (${err instanceof Error ? err.name : "error"})`);
    return "skipped";
  } finally {
    access?.release();
  }
}
