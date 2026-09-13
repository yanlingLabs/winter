import { isDefaultWinterHome } from "./winter-dir";

/** The dev/distribution profile. Everything identity-shaped that WINTER_HOME does not already
 *  parameterize derives from this: the Keychain service (secret-store.ts) and the CLI's launchd
 *  label (packages/cli/src/launchd.ts). Unset/unknown env values mean "dist" — the dist Keychain
 *  service is now `com.winter.core` (dev: `com.winter.core.dev`), a NEW pair holding nothing
 *  until Migration B (9c) copies over the pre-rename items. See `legacy-names.ts`'s
 *  `LEGACY_KEYCHAIN_SERVICE[_DEV]` for the pre-rename pair that 9c's migrator reads from. */
export type WinterProfile = "dist" | "dev";

export function resolveWinterProfile(env: NodeJS.ProcessEnv = process.env): WinterProfile {
  return env.WINTER_PROFILE === "dev" ? "dev" : "dist";
}

/**
 * Keychain service for Bun.secrets. `com.winter.core` (dev: `.dev`) is a NEW, empty pair —
 * the pre-rename items (`legacy-names.ts`'s `LEGACY_KEYCHAIN_SERVICE[_DEV]`) are copied over
 * only by Migration B (9c).
 *
 * HERMETICITY FIX (test-keychain-isolation): `WINTER_KEYCHAIN_SERVICE`, when set, overrides the
 * returned service name — but ONLY when the caller EXPLICITLY passes a `home` that is NOT the
 * profile's own default home (`~/.winter` dist, `~/.winter-dev` dev — `winter-dir.ts`'s
 * `isDefaultWinterHome`, the P9c-15 rule). `home` is intentionally NOT defaulted to
 * `resolveWinterHome()`: that resolver reads only `WINTER_HOME` (never `WINTER_PROFILE`), so with
 * no `WINTER_HOME` set it always answers the DIST path regardless of `profile` — silently mismatching
 * a caller who passed `profile: "dev"` for its literal alone (`console-profile-broker.ts`,
 * `migrate-b.ts`, a bare `keychainService("dev")`) and wrongly treating that as a "non-default home".
 * Omitting `home` therefore means "I'm not asserting anything about which home this is" and NEVER
 * engages the override. A daemon on its profile's DEFAULT home (`~/.winter`, `~/.winter-dev`) can
 * never be redirected by an env var some other process happens to have set; a daemon deliberately
 * run on a custom `WINTER_HOME` DOES honour it (and warns), so the variable belongs only in a test
 * preload. This is the ONE function every consumer of the Keychain service name must derive from — the
 * brand handed to the router (`runtime-sdk/brand.ts`) and every `CredentialRef` the child resolves
 * against (`runtime-sdk/keychain.ts`, `runtime-sdk/provider-selection.ts`) thread their caller's
 * REAL `home` through explicitly. `test/preload.ts` sets the env var to a throwaway service name
 * with no items so a real-binary e2e test's spawned child can never reach the user's real
 * `com.winter.core[.dev]` Keychain items.
 */
export function keychainService(
  profile: WinterProfile = resolveWinterProfile(),
  home?: string,
): string {
  const base = profile === "dev" ? "com.winter.core.dev" : "com.winter.core";
  const override = process.env.WINTER_KEYCHAIN_SERVICE;
  if (!override || home === undefined) return base;
  if (isDefaultWinterHome(home, profile)) return base;
  console.warn(`[keychain] WINTER_KEYCHAIN_SERVICE override honoured for non-default home "${home}": using "${override}" instead of "${base}"`);
  return override;
}

export function profileDisplayName(profile: WinterProfile = resolveWinterProfile()): string {
  return profile === "dev" ? "Winter Dev" : "Winter";
}
