import { resolve } from "node:path";
import { canonicalizeForWrite, resolveLeafSymlinks } from "../agent/paths";
import { escapeSandboxGlobPath } from "@yanlinglabs/winter-runtime-sdk";
import { homeFenceFor } from "./home-fence";
import { hostStorageReadPatterns } from "./host-storage-fence";

/** Trusted Worker lifecycle policy. Never serialized into model settings, RuntimeConfig or env. */
export interface EmbeddedHostPathProtection {
  revision: number;
  denyReadPaths: readonly string[];
  denyWritePaths: readonly string[];
}
export interface EmbeddedProtectionCoverage {
  fileTools: readonly string[];
  ordinarySandboxPathChecks: boolean;
  approvedEscapesKeepMainBehavior: boolean;
  contextReadChecksVersion: number;
  sourceReaderFamilies?: readonly string[];
}
export interface EmbeddedProtectionCapability {
  contractVersion: number;
  capability: string;
  coverage: EmbeddedProtectionCoverage;
}
/** Source advertisements are not independent acceptance. Remains zero until the complete
 * context/cache boundary passes review; package pins remain a separate release requirement. */
export const ACCEPTED_EMBEDDED_CONTEXT_VERSION: number = 0;
const REQUIRED_SOURCE_FAMILIES = ["instructions-imports-memory", "rules", "output-styles", "settings-mcp", "skills", "agent-definitions", "plugin-components-manifests-installed", "commands", "workflow-source"];
const REQUIRED_FILE_TOOLS = ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"];
export function embeddedFileProtectionSupported(value: EmbeddedProtectionCapability | undefined): boolean {
  return !!value?.coverage && Array.isArray(value.coverage.fileTools) && value.contractVersion === 1 && value.capability === "host-code-path-protection-v1"
    && value.coverage.ordinarySandboxPathChecks === true
    && value.coverage.approvedEscapesKeepMainBehavior === true
    && REQUIRED_FILE_TOOLS.every(tool => value.coverage.fileTools.includes(tool));
}
/** Read/Write alone does not authorize in-process instruction/settings/Skill/plugin readers. */
export function embeddedContextProtectionSupported(value: EmbeddedProtectionCapability | undefined, acceptedVersion = ACCEPTED_EMBEDDED_CONTEXT_VERSION): boolean {
  return acceptedVersion === 1 && embeddedFileProtectionSupported(value) && value?.coverage.contextReadChecksVersion === 1
    && Array.isArray(value.coverage.sourceReaderFamilies) && REQUIRED_SOURCE_FAMILIES.every(family => value.coverage.sourceReaderFamilies!.includes(family));
}
const spellings = (path: string): string[] => {
  const out = [resolve(path)];
  try { out.push(canonicalizeForWrite(resolveLeafSymlinks(resolve(path)))); } catch { /* literal still protects */ }
  return [...new Set(out)].map(escapeSandboxGlobPath);
};
export function embeddedHostPathProtection(home: string, revision: number): EmbeddedHostPathProtection {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid host path-policy revision");
  const fence = homeFenceFor(home);
  const reads = hostStorageReadPatterns(home).flatMap(({ root, tail }) => spellings(root).map(path => tail === "**" ? path : `${path}/${tail}`));
  const writes = [...fence.dirs, ...fence.files].flatMap(spellings);
  return Object.freeze({ revision,
    denyReadPaths: Object.freeze([...new Set(reads)].sort()),
    denyWritePaths: Object.freeze([...new Set(writes)].sort()),
  });
}
