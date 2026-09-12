/** The dev/distribution profile. Everything identity-shaped that WINTER_HOME does not already
 *  parameterize derives from this: the Keychain service (secret-store.ts) and the CLI's launchd
 *  label (packages/cli/src/launchd.ts). Unset/unknown env values mean "dist" — existing installs
 *  keep the exact literals they shipped with. */
export type WinterProfile = "dist" | "dev";

export function resolveWinterProfile(env: NodeJS.ProcessEnv = process.env): WinterProfile {
  return env.WINTER_PROFILE === "dev" ? "dev" : "dist";
}

/** Keychain service for Bun.secrets. Dist stays the historical literal — never migrate. */
export function keychainService(profile: WinterProfile = resolveWinterProfile()): string {
  return profile === "dev" ? "com.winter.core.dev" : "com.winter.core";
}

export function profileDisplayName(profile: WinterProfile = resolveWinterProfile()): string {
  return profile === "dev" ? "Winter Dev" : "Winter";
}
