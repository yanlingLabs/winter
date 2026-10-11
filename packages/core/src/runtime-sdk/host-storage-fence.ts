import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizeForWrite, resolveLeafSymlinks } from "../agent/paths";

/** Injected by the host coordinator, never inferred from manifests or a scan of user homes. */
export interface HostStorageFenceOptions {
  participatingHomes?: readonly string[];
  coordinationDir?: string;
  /** Once backing storage is usable, an escape without a persistent kernel fence must refuse. */
  coworkStorageActive?: boolean;
}
const registered = new Map<string, HostStorageFenceOptions>();
export function registerHostStorageFences(home: string, options: HostStorageFenceOptions): () => void {
  const key = resolve(home);
  if (!options.coordinationDir) throw new Error("Host storage registration requires an explicit coordination directory");
  const spelling = (path: string) => {
    const paths = [resolve(path)];
    try { paths.push(canonicalizeForWrite(resolveLeafSymlinks(resolve(path)))); } catch { /* literal still binds */ }
    return paths.map(path => path.toLowerCase());
  };
  const domains = spelling(options.coordinationDir);
  for (const h of [home, ...(options.participatingHomes ?? [])]) {
    for (const candidate of spelling(h)) for (const domain of domains) {
      if (candidate === domain || candidate.startsWith(`${domain}/`) || domain.startsWith(`${candidate}/`)) throw new Error("Winter homes may not overlap host coordination storage");
    }
  }
  const previous = registered.get(key);
  const registration = { ...options, participatingHomes: [...(options.participatingHomes ?? [])] };
  registered.set(key, registration);
  return () => {
    if (registered.get(key) !== registration) return;
    if (previous) registered.set(key, previous); else registered.delete(key);
  };
}
export function hostStorageFenceOptions(home: string, options?: HostStorageFenceOptions): Required<HostStorageFenceOptions> {
  const config = options ?? registered.get(resolve(home)) ?? {};
  return {
    participatingHomes: [...new Set([resolve(home), ...registered.keys(),
      ...[...registered.values()].flatMap((registration) => registration.participatingHomes ?? []).map((h) => resolve(h)),
      ...(config.participatingHomes ?? []).map((h) => resolve(h))])],
    // Spelling only: fence construction never opens the production coordination store.
    coordinationDir: resolve(config.coordinationDir ?? process.env.WINTER_COWORK_COORDINATION_DIR ?? join(homedir(), "Library/Application Support/Winter/Coordination")),
    coworkStorageActive: config.coworkStorageActive === true || [...registered.values()].some((r) => r.coworkStorageActive === true),
  };
}
export const COWORK_CONTROL_ENTRIES = ["manifest.json", "env.ext4", "data.ext4", "control"] as const;
export function hostStorageWriteRoots(home: string, options?: HostStorageFenceOptions): string[] {
  const config = hostStorageFenceOptions(home, options);
  return [...config.participatingHomes.flatMap((h) => [join(h, "cowork"), join(h, "runtimes")]), config.coordinationDir];
}
/** Literal prefixes and glob tails are kept separate until a consumer spells its own grammar. */
export function hostStorageReadPatterns(home: string, options?: HostStorageFenceOptions): Array<{ root: string; tail: string }> {
  const config = hostStorageFenceOptions(home, options);
  return [
    { root: config.coordinationDir, tail: "**" },
    ...config.participatingHomes.flatMap((h) => [
      { root: join(h, "runtimes"), tail: "**" },
      { root: join(h, "cowork", "control"), tail: "**" },
      ...COWORK_CONTROL_ENTRIES.map((entry) => ({ root: join(h, "cowork", "workspaces"), tail: `*/${entry}${entry === "control" ? "/**" : ""}` })),
    ]),
  ];
}
