// Winter Phase 8d — the compiled-binary probe behind `norma-core __runtimes-probe` (Lane 1 fills
// this; the spine ships the contract and a stub so the CLI route and `verify:runtimes` compile).
// It runs OUTSIDE a daemon (no settings, no store), resolves both executable ladders from the
// given execPath/home/env, and reports what it found. It NEVER spawns `winter` (the pinned build
// has no version flag — controller measurement M2) and never calls `resolveNormaHome()`.
import type { VersionsJson } from "./bundle-layout";

export interface RuntimesProbeResult {
  ok: boolean;
  winter: { path?: string; source?: string; executable: boolean; signature?: string };
  claude: { path?: string; source?: string; executable: boolean; version?: string; teamIdentifier?: string };
  versions?: VersionsJson;
  errors: string[];
}

export async function runRuntimesProbe(_input: { execPath: string; home: string; env: Record<string, string | undefined> }): Promise<RuntimesProbeResult> {
  return { ok: false, winter: { executable: false }, claude: { executable: false }, errors: ["runtimes probe not implemented (Phase 8d lane 1)"] };
}
