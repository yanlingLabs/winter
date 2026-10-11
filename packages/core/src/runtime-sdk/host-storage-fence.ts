import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizeForWrite, resolveLeafSymlinks } from "../agent/paths";
import { lstatSync } from "node:fs";

/** Injected by the host coordinator, never inferred from manifests or a scan of user homes. */
export interface HostStorageFenceOptions {
  participatingHomes?: readonly string[];
  coordinationDir?: string;
  /** Protected retained storage exists. This remains true while a guest is stopped or archived. */
  coworkStorageActive?: boolean;
}
const registered = new Map<string, HostStorageFenceOptions>();
export class HostStorageFenceUnavailable extends Error {
  readonly code="winter_leg_unavailable" as const;
  constructor(readonly reason:"cowork-root-symlink"|"cowork-root-not-directory"|"cowork-root-unavailable") {
    super("Protected Cowork storage cannot be inspected safely; host runtime execution remains blocked until its storage identity is recovered");
    this.name="HostStorageFenceUnavailable";
  }
}
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
export const COWORK_RUNTIME_AUTHORITY_FILES = ["runtime-state.db", "runtime-state.db-wal", "runtime-state.db-shm"] as const;
/** Only explicit coordinator registrations can introduce Cowork read/ancestor protection. A disabled
 * feature or an unused home must not change ordinary Code scans of HOME, Library or /. Provisioning
 * creates an empty owned root, registers it and refreshes runtime floors BEFORE materializing data. */
export function protectedHostStorageFences(home: string, options?: HostStorageFenceOptions): { homes: string[]; coordinationDirs: string[] } {
  const registrations: Array<readonly [string, HostStorageFenceOptions]> = [...registered];
  if (options) registrations.push([resolve(home), options]);
  const homes=new Set<string>(), coordinationDirs=new Set<string>();
  for (const [owner, registration] of registrations) {
    if (registration.coworkStorageActive !== true) continue;
    let retained=false;
    for (const candidate of [owner, ...(registration.participatingHomes ?? [])]) {
      const h=resolve(candidate);
      try {
        const st=lstatSync(join(h,"cowork"));
        if (st.isSymbolicLink()) throw new HostStorageFenceUnavailable("cowork-root-symlink");
        if (!st.isDirectory()) throw new HostStorageFenceUnavailable("cowork-root-not-directory");
        homes.add(h); retained=true;
      } catch (error) {
        if (error instanceof HostStorageFenceUnavailable) throw error;
        if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw new HostStorageFenceUnavailable("cowork-root-unavailable");
      }
    }
    if (retained) coordinationDirs.add(hostStorageFenceOptions(owner, registration).coordinationDir);
  }
  return { homes:[...homes], coordinationDirs:[...coordinationDirs] };
}
export function hostStorageWriteRoots(home: string, options?: HostStorageFenceOptions): string[] {
  const active = protectedHostStorageFences(home, options);
  return [...active.homes.flatMap((h) => [join(h, "cowork"), join(h, "runtimes")]), ...active.coordinationDirs];
}
/** Literal prefixes and glob tails are kept separate until a consumer spells its own grammar. */
export function hostStorageReadPatterns(home: string, options?: HostStorageFenceOptions): Array<{ root: string; tail: string }> {
  const active = protectedHostStorageFences(home, options);
  return [
    ...active.coordinationDirs.map(root => ({root, tail:"**"})),
    ...active.homes.flatMap((h) => [
      { root: join(h, "runtimes"), tail: "**" },
      { root: join(h, "cowork", "control"), tail: "**" },
      ...COWORK_CONTROL_ENTRIES.map((entry) => ({ root: join(h, "cowork", "workspaces"), tail: `*/${entry}${entry === "control" ? "/**" : ""}` })),
    ]),
  ];
}

/** Host-owned spawn input, never an editable settings value. The SDK consumes this outside normal
 * permission policy and wraps the whole Code runtime, including its file tools and shell escapes.
 * Applying a changed descriptor requires draining/restarting every affected runtime generation.
 * This descriptor alone does not activate kernel enforcement or enable Cowork. */
export interface HostStorageFloorDescriptor {
  denyReadPaths: string[];
  denyWritePaths: string[];
  denyReadRegexes: string[];
  denyWriteRegexes: string[];
  denyLinkPaths: string[];
  protectAncestorsOf: string[];
}
export function hostStorageFloorDescriptor(home: string, options?: HostStorageFenceOptions): HostStorageFloorDescriptor {
  const spellings=(path:string):string[] => {
    const out=[resolve(path)];
    try { out.push(canonicalizeForWrite(resolveLeafSymlinks(resolve(path)))); } catch { /* registered literal still binds */ }
    return [...new Set(out)];
  };
  const escapeRegex=(value:string) => value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const active=protectedHostStorageFences(home,options);
  // The outer floor wraps the trusted runtime as well as its tools. A legacy executable may itself
  // live in runtimes/bin; fence the authority DB, not that executable or other runtime-owned data.
  const runtimeFiles=active.homes.flatMap(h => COWORK_RUNTIME_AUTHORITY_FILES.map(name => join(h,"runtimes",name)));
  const runtimeRoots=new Set(active.homes.map(h => join(h,"runtimes")));
  const write=[...new Set([...active.homes.map(h => join(h,"cowork")),...active.coordinationDirs,...runtimeFiles].flatMap(spellings))];
  const paths:string[]=[],regexes:string[]=[];
  for (const {root,tail} of hostStorageReadPatterns(home,options)) {
    if (runtimeRoots.has(root)) {
      paths.push(...COWORK_RUNTIME_AUTHORITY_FILES.flatMap(name => spellings(join(root,name))));
      continue;
    }
    for (const base of spellings(root)) {
      if (tail==="**") paths.push(base);
      else {
        const entry=tail.slice(2).replace(/\/\*\*$/,"");
        regexes.push(`^${escapeRegex(base)}/[^/]+/${escapeRegex(entry)}(/|$)`);
      }
    }
  }
  return {denyReadPaths:[...new Set(paths)],denyWritePaths:write,denyReadRegexes:[...new Set(regexes)],denyWriteRegexes:[],
    denyLinkPaths:[...write],protectAncestorsOf:[...write]};
}
