// ComputerV2 (2026-10-08, the daemon review's I2) — the automation worker's OWN seatbelt profile. Stricter than
// the workflow worker's (`workflows/sandbox.ts`, which allows `file-read*` everywhere): a script runs under EVERY
// policy with no card, and `this.process`, `Function("return process")()` and `import("node:fs")` are all reachable
// from a script (name shadowing is defense in depth only), so the profile is what makes them useless:
//
//   - READS are an ALLOWLIST: the system (`/System`, `/usr/lib`, `/usr/share`, the dyld cache, the timezone
//     data), a few devices, the running binary itself, and — in dev only, where Bun runs the entry from source —
//     `packages/core` and the repo root's own config files. Everything else is denied: the user's home in general,
//     `/etc`, the per-user temp dirs, and therefore `<WINTER_HOME>` and the files `Read`/`Glob`/the bash sandbox
//     fence (`denyRead`). Those are ALSO denied explicitly, last (a later rule wins), in case a dev source root
//     ever contains one. Metadata (`stat`, needed to resolve a path) stays allowed; directory LISTINGS do not.
//   - NO writes, NO network, exec of itself only, no fork, the workflow worker's four mach services (never a
//     Keychain service — `workflows/sandbox-guard.ts` refuses to run under any profile that allows one).
//
// Measured on both shapes (`bun entry.ts` and the compiled `winter-core`): Bun reads `/` itself at startup, and
// nothing under `/Users` but the binary (compiled) or the source tree (dev).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WORKFLOW_MACH_SERVICES } from "../workflows/sandbox";

function sbplString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function canon(p: string): string { try { return realpathSync(p); } catch { return p; } }

/** The read-only system locations any Bun binary needs. */
const SYSTEM_READ_SUBPATHS = ["/System", "/usr/lib", "/usr/share", "/private/var/db/dyld", "/private/var/db/timezone"] as const;
const SYSTEM_READ_LITERALS = ["/", "/private/etc/localtime", "/dev/null", "/dev/urandom", "/dev/random", "/dev/zero"] as const;

export interface AutomationSandboxInput {
  /** The binary the worker runs as (`winter-core`, or `bun` in dev). */
  selfExecPath: string;
  /** Dev only: the repo root whose `packages/core` the worker's entry is loaded from. */
  devSourceRoot?: string;
  /** Paths denied even if an allowed subpath would cover them — `<WINTER_HOME>` and the Read fence's set. */
  denyRead?: readonly string[];
}

export function buildAutomationSeatbeltProfile(input: AutomationSandboxInput): string {
  const self = canon(input.selfExecPath);
  const machRules = WORKFLOW_MACH_SERVICES.map((s) => `  (global-name "${sbplString(s)}")`).join("\n");
  const reads = [
    ...SYSTEM_READ_SUBPATHS.map((p) => `  (subpath "${sbplString(p)}")`),
    ...SYSTEM_READ_LITERALS.map((p) => `  (literal "${sbplString(p)}")`),
    `  (literal "${sbplString(self)}")`,
  ];
  if (input.devSourceRoot !== undefined) {
    const root = canon(input.devSourceRoot);
    reads.push(`  (subpath "${sbplString(join(root, "packages", "core"))}")`);
    for (const f of ["", "package.json", "tsconfig.base.json", "bunfig.toml"]) reads.push(`  (literal "${sbplString(f === "" ? root : join(root, f))}")`);
  }
  const denies = [...new Set((input.denyRead ?? []).filter((p) => p.length > 0).map(canon))]
    .map((p) => `(deny file-read* (subpath "${sbplString(p)}"))`).join("\n");
  return `(version 1)
(deny default)
(allow process-exec (literal "${sbplString(self)}"))
(deny process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup
${machRules})
(allow file-read-metadata)
(allow file-read*
${reads.join("\n")})
(deny file-write*)
(deny network*)
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr"))
${denies}
`;
}

/** The repo root when the daemon runs from source (dev/test), else undefined (a compiled binary). */
export function devSourceRootFor(): string | undefined {
  if (typeof Bun !== "undefined" && (Bun.main.startsWith("/$bunfs/") || Bun.main.includes("/$bunfs/"))) return undefined;
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

/** The worker's environment: nothing of the daemon's (a dev daemon's shell may export keys — review I2). */
export const AUTOMATION_WORKER_ENV: Readonly<Record<string, string>> = { PATH: "/usr/bin:/bin" };
