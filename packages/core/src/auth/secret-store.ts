import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keychainService, resolveWinterProfile } from "../profile";

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  /**
   * WS-19 (W19-2): remove the item outright. `true` when something was actually removed, `false`
   * when there was nothing there — the exact shape `credential.remove`'s `removed` field reports.
   *
   * Winter used to have no delete at all: `clearCredentialMaterial` wrote an EMPTY STRING and every
   * reader treated a blank as absent (`readCredentialMaterial`'s own `if (!raw) return null`). That
   * blank-as-absent rule is NOT retired by this method — a home written by an older build still
   * holds blanked items, and they must keep reading as absent — but a *new* removal deletes rather
   * than blanks, so a removed credential leaves no row behind at all.
   */
  delete(name: string): Promise<boolean>;
}

// DD branch review rider: resolved ONCE at module load (unlike `launchdLabel()`'s call-time
// `resolveWinterProfile()` default param) — deliberate, but it means `WINTER_PROFILE` must be set
// in the environment BEFORE this module is first imported. Mutating `process.env.WINTER_PROFILE`
// afterward is inert; `SERVICE` will not re-resolve. This is why a launchd-installed dev daemon
// MUST have `WINTER_PROFILE` baked into its plist's `EnvironmentVariables` (see
// `packages/cli/src/launchd.ts` `renderPlist`) rather than relying on any later mutation.
//
// ISOLATION FIX (2026-10-09): the home an EXPLICIT `WINTER_HOME` names is passed through, so a process run on a
// custom home honours `WINTER_KEYCHAIN_SERVICE` (`keychainService`'s own rule). Without it this store — the
// daemon's and the CLI's — always used the profile's REAL service: a hand-started daemon on a temp home probed
// `com.winter.core[.dev]` and raised one Keychain prompt per item another binary created. No `WINTER_HOME`
// still means "assert nothing" (the real service), exactly as before.
export const DEFAULT_SECRET_SERVICE = keychainService(resolveWinterProfile(), explicitWinterHome());

function explicitWinterHome(): string | undefined {
  const home = process.env.WINTER_HOME;
  return home !== undefined && home.length > 0 ? home : undefined;
}

const SERVICE = DEFAULT_SECRET_SERVICE;

/** `app-token-acl.ts`'s `APP_TOKEN_SHADOW_SUFFIX`, spelled here so this module stays free of the FFI. */
export const MIGRATION_SHADOW_SUFFIX = ".migrating";

/** Production store: macOS Keychain via Bun.secrets. */
export class KeychainSecretStore implements SecretStore {
  /** `backend`/`service` exist for tests only (a recording fake — never the real Keychain). */
  constructor(private readonly backend: Pick<typeof Bun.secrets, "get" | "set" | "delete"> = Bun.secrets, private readonly service: string = SERVICE) {}
  async get(name: string): Promise<string | null> {
    return (await this.backend.get({ service: this.service, name })) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    await this.backend.set({ service: this.service, name, value });
  }
  /** `Bun.secrets.delete` already answers the exact boolean this interface promises ("true if a
   *  credential was deleted, false if not found"), so nothing is re-derived here. WS-27: a migration
   *  shadow of the item (`<name>.migrating`, `auth/credential-acl.ts`) goes with it, so a removed
   *  credential can never be restored from one — deleted FIRST; its own result does not change the answer. */
  async delete(name: string): Promise<boolean> {
    // The shadow FIRST: a crash between the two deletes must never leave a shadow beside a missing original,
    // which recovery would restore.
    if (!name.endsWith(MIGRATION_SHADOW_SUFFIX)) {
      try { await this.backend.delete({ service: this.service, name: `${name}${MIGRATION_SHADOW_SUFFIX}` }); } catch { /* none, or not ours */ }
    }
    return await this.backend.delete({ service: this.service, name });
  }
}

/** Test/CI store: 0600 files in a directory. Never used in production paths. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  async get(name: string): Promise<string | null> {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  async set(name: string, value: string): Promise<void> {
    const p = join(this.dir, name);
    writeFileSync(p, value, { mode: 0o600 });
  }
  /** Unlink, reporting whether a file was actually there. `rmSync(..., {force:true})` never throws
   *  for a missing path, so the existence check decides the return value rather than a caught
   *  ENOENT. */
  async delete(name: string): Promise<boolean> {
    const p = join(this.dir, name);
    const existed = existsSync(p);
    rmSync(p, { force: true });
    return existed;
  }
}
