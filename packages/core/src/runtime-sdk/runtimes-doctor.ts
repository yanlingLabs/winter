// Winter Phase 8d — `norma doctor`'s "runtimes" section (Lane 1 fills; Lane 4 prints). Diagnoses
// where each runtime executable resolves from (or the typed reason it does not) and, when the
// bundle rung resolved, the bundle's VERSIONS.json. READ-ONLY: never spawns a runtime, never
// touches a store; safe beside a live daemon.
import type { Settings } from "../settings";
import type { VersionsJson } from "./bundle-layout";

export interface RuntimesReport {
  winter: { resolved?: { path: string; source: string }; error?: string };
  claude: { resolved?: { path: string; source: string }; error?: string; installedWrapper?: string; platformPackage?: string };
  bundle?: { versions?: VersionsJson; error?: string };
}

export async function diagnoseRuntimes(_input: { execPath: string; home: string; env: Record<string, string | undefined>; settings: Settings | undefined }): Promise<RuntimesReport> {
  return { winter: { error: "runtimes doctor not implemented (Phase 8d lane 1)" }, claude: { error: "runtimes doctor not implemented (Phase 8d lane 1)" } };
}
