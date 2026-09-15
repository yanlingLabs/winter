// Phase 9c Migration B — a `SecretStore` bound to the LEGACY Keychain service name, so
// `daemon.ts`'s production boot hook can hand `runMigrationB` a real `from` store without
// `auth/secret-store.ts`'s `KeychainSecretStore` (whose service is resolved ONCE at module load
// from the CURRENT profile — see that file's own doc comment — and so can never speak for a
// different, legacy service). This is the ONLY place in the tree that constructs a `Bun.secrets`
// store bound to `LEGACY_KEYCHAIN_SERVICE[_DEV]`; every test path uses an in-memory/file
// `SecretStore` instead (Global Constraints: never `Bun.secrets` in a test).
import type { SecretStore } from "../auth/secret-store";
import type { WinterProfile } from "../profile";
import { LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE_DEV } from "../legacy-names";

export function legacyKeychainServiceFor(profile: WinterProfile): string {
  return profile === "dev" ? LEGACY_KEYCHAIN_SERVICE_DEV : LEGACY_KEYCHAIN_SERVICE;
}

/** Read/write against the pre-rename Keychain service for `profile`. Production wiring only —
 *  `daemon.ts`'s boot hook constructs this exactly once, only when no test override was supplied
 *  (see `startDaemon`'s migration seam). */
export class LegacyKeychainSecretStore implements SecretStore {
  private readonly service: string;
  constructor(profile: WinterProfile) {
    this.service = legacyKeychainServiceFor(profile);
  }
  async get(name: string): Promise<string | null> {
    return (await Bun.secrets.get({ service: this.service, name })) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    await Bun.secrets.set({ service: this.service, name, value });
  }
  /** WS-19 (W19-2) completes the `SecretStore` interface here too, but NOTHING in Migration B calls
   *  it: the pre-rename Keychain items are the ROLLBACK SOURCE and must stay untouched (CLAUDE.md's
   *  own hard rule about the legacy app, home and Keychain service), so the migration only ever
   *  READS this store. It exists so the type is total, not so a caller can erase the fallback. */
  async delete(name: string): Promise<boolean> {
    return await Bun.secrets.delete({ service: this.service, name });
  }
}
