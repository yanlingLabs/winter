import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keychainService } from "../profile";

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

// DD branch review rider: resolved ONCE at module load (unlike `launchdLabel()`'s call-time
// `resolveNormaProfile()` default param) — deliberate, but it means `NORMA_PROFILE` must be set
// in the environment BEFORE this module is first imported. Mutating `process.env.NORMA_PROFILE`
// afterward is inert; `SERVICE` will not re-resolve. This is why a launchd-installed dev daemon
// MUST have `NORMA_PROFILE` baked into its plist's `EnvironmentVariables` (see
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
}
