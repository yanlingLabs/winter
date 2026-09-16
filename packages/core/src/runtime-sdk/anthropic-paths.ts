import { join } from "node:path";

/** WS-20: pure path helpers for the official leg's Console-profile arm, split out of
 *  `official-options.ts` so `settings.ts` (the v2→v3 migration's console-arm detection, §5 rule
 *  4) can import them without creating a cycle — `official-options.ts` itself imports from
 *  `settings.ts` (`officialSubscriptionAuthEnabled`). This module imports nothing from
 *  `settings.ts` and never will. */
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

/** The console profile's own credential file — the official leg's "auto"/console-arm resolution
 *  probes this path's existence, and nothing else (presence, never validity — same "presence is
 *  not validity" discipline `keychain.ts`'s `credentialPresenceFrom` documents for the
 *  Keychain-backed rows). */
export function consoleProfileCredentialFile(home: string): string {
  return join(anthropicConfigDirFor(home), "credentials", `${ANTHROPIC_PROFILE_NAME}.json`);
}
