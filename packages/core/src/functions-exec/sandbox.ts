import { existsSync, realpathSync, statSync } from "node:fs";

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function quote(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function readRule(path: string): string {
  try {
    return statSync(path).isDirectory() ? `(subpath "${quote(path)}")` : `(literal "${quote(path)}")`;
  } catch {
    return `(literal "${quote(path)}")`;
  }
}

export interface FunctionsExecSandboxOptions {
  workerExecutable: string;
  runtimePaths: readonly string[];
  protectedRoots: readonly string[];
}

/**
 * Builds the deliberately read-denying Seatbelt profile used only by the private worker process.
 * Runtime source and the system libraries Bun needs are the sole read exceptions; the caller's
 * approved roots are denied again afterwards, so they cannot become visible through a broad
 * runtime directory allowance.
 */
export function buildFunctionsExecSeatbeltProfile(options: FunctionsExecSandboxOptions): string {
  if (options.protectedRoots.length === 0) throw new Error("functions.exec requires protected roots");
  const executable = canonical(options.workerExecutable);
  const runtimePaths = [...new Set([executable, ...options.runtimePaths.map(canonical)])];
  const protectedRoots = [...new Set(options.protectedRoots.map(canonical))];
  const runtimeRules = runtimePaths.map(readRule).join("\n  ");
  const protectedRules = protectedRoots.map((path) => `(deny file-read* (subpath "${quote(path)}"))`).join("\n");

  return `(version 1)
(deny default)
(allow process-exec (literal "${quote(executable)}"))
(deny process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/usr/share"))
(allow file-read* (subpath "/private/var/db/dyld"))
(allow file-read* (literal "/dev/null"))
(allow file-read*
  ${runtimeRules})
${protectedRules}
(deny file-write*)
(deny network*)
(allow file-write-data (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/null"))
`;
}

export function functionsExecSandboxAvailable(
  platform: NodeJS.Platform = process.platform,
  hasSeatbelt: boolean = existsSync("/usr/bin/sandbox-exec"),
): boolean {
  return platform === "darwin" && hasSeatbelt;
}
