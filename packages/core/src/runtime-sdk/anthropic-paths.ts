import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** WS-20: pure path helpers for the Anthropic Console profile, kept apart from anything that imports
 *  `settings.ts` so `settings.ts` (the v2→v3 migration's console-arm detection, §5 rule 4) can import
 *  them without creating a cycle. This module imports nothing from `settings.ts` and never will.
 *
 *  WS-23: the official `claude` leg that used to share this directory is gone; `ant` is still the
 *  Console's one login and token-refresh door (`auth/console-profile-broker.ts`), and it is `ant` that
 *  reads and writes the profile under this directory. */
export function anthropicConfigDirFor(home: string): string {
  return join(home, "runtimes", "anthropic-config");
}

/** P10a-2: the ONE profile name every login/refresh/logout call names — `ant auth login --profile
 *  ${ANTHROPIC_PROFILE_NAME}` writes `<anthropicConfigDirFor(home)>/credentials/${ANTHROPIC_PROFILE_NAME}.json`,
 *  and `ant auth print-credentials --profile ${ANTHROPIC_PROFILE_NAME}` reads the identical file
 *  (fix wave 3 M-A: `claude auth login --console` was measured to write neither this file nor
 *  anything else under `ANTHROPIC_CONFIG_DIR` at all). Winter never supports more than one
 *  Anthropic Console profile — a literal, not a setting. */
export const ANTHROPIC_PROFILE_NAME = "winter";

/** The console profile's own credential file — presence, never validity (the same "presence is not
 *  validity" discipline `keychain.ts`'s `credentialPresenceFrom` documents for the Keychain-backed
 *  rows). */
export function consoleProfileCredentialFile(home: string): string {
  return join(anthropicConfigDirFor(home), "credentials", `${ANTHROPIC_PROFILE_NAME}.json`);
}

/**
 * A directory `ant` keeps credentials under, created if absent and hardened to 0700 EVERY time — a
 * stale, more permissive mode is corrected on each call, not only the first. Idempotent. (It used to
 * live beside the official leg's own config dir as `ensureOfficialConfigDir`; the Console profile
 * directories are its only callers now.)
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
}

/**
 * WS-20: `provider.status`'s "which Anthropic credentials actually exist" report — presence ALONE.
 * `"both"` when the API-key material AND the Console profile both exist: a session's own tag
 * (`anthropic/*` or `console/*`) decides which one it uses, and this function does not guess on the
 * caller's behalf.
 */
export function effectiveAnthropicAuthFor(apiKey: boolean, consoleProfile: boolean): "both" | "api-key" | "console" | "none" {
  if (apiKey && consoleProfile) return "both";
  if (consoleProfile) return "console";
  if (apiKey) return "api-key";
  return "none";
}
