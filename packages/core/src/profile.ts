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

/** Keychain service for Bun.secrets. `com.winter.core` (dev: `.dev`) is a NEW, empty pair —
 *  the pre-rename items (`legacy-names.ts`'s `LEGACY_KEYCHAIN_SERVICE[_DEV]`) are copied over
 *  only by Migration B (9c). */
export function keychainService(profile: WinterProfile = resolveWinterProfile()): string {
  return profile === "dev" ? "com.winter.core.dev" : "com.winter.core";
}

export function profileDisplayName(profile: WinterProfile = resolveWinterProfile()): string {
  return profile === "dev" ? "Winter Dev" : "Winter";
}
