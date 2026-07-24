/** The dev/distribution profile. Everything identity-shaped that NORMA_HOME does not already
 *  parameterize derives from this: the Keychain service (secret-store.ts) and the CLI's launchd
 *  label (packages/cli/src/launchd.ts). Unset/unknown env values mean "dist" — existing installs
 *  keep the exact literals they shipped with. */
export type NormaProfile = "dist" | "dev";

export function resolveNormaProfile(env: NodeJS.ProcessEnv = process.env): NormaProfile {
  return env.NORMA_PROFILE === "dev" ? "dev" : "dist";
}

/** Keychain service for Bun.secrets. Dist stays the historical literal — never migrate. */
export function keychainService(profile: NormaProfile = resolveNormaProfile()): string {
  return profile === "dev" ? "com.norma.core.dev" : "com.norma.core";
}

export function profileDisplayName(profile: NormaProfile = resolveNormaProfile()): string {
  return profile === "dev" ? "Norma Dev" : "Norma";
}
