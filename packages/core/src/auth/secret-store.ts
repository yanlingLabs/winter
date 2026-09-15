import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keychainService } from "../profile";

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
const SERVICE = keychainService();

/** Production store: macOS Keychain via Bun.secrets. */
export class KeychainSecretStore implements SecretStore {
  async get(name: string): Promise<string | null> {
    return (await Bun.secrets.get({ service: SERVICE, name })) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    await Bun.secrets.set({ service: SERVICE, name, value });
  }
  /** `Bun.secrets.delete` already answers the exact boolean this interface promises ("true if a
   *  credential was deleted, false if not found"), so nothing is re-derived here. */
  async delete(name: string): Promise<boolean> {
    return await Bun.secrets.delete({ service: SERVICE, name });
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
