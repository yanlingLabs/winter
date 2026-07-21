import { realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxOptions {
  cwd: string;                 // session working directory — always a writable root
  writableRoots?: string[];    // extra writable subpaths (default: [os.tmpdir()])
  allowNetwork?: boolean;      // default false
}

/** Escape a path for embedding inside an SBPL double-quoted string literal. */
function sbplString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** realpath a path if it exists (canonicalizes macOS /tmp and /var symlinks); pass through otherwise. */
function canon(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Build a macOS Seatbelt (SBPL) profile: deny-by-default, read anywhere,
 * write only under the given roots, network denied unless opted in.
 *
 * SP-approvals final review (composition hole, HIGH, defense-in-depth): EVERY writable root
 * (cwd + each of `writableRoots`) additionally gets an explicit `(deny file-write* (literal
 * "<root>/.norma/permissions.local.json"))` line, unconditionally — automatic for every caller,
 * with no opt-in flag to forget. This is the bash-invoked-write half of the same fix engine.ts's
 * dispatch loop applies to the write/edit TOOLS (`permissionRulesFileTarget`): a bash command like
 * `echo x > .norma/permissions.local.json` never goes through that tool-level check at all — the
 * seatbelt is the only enforcement point left for it. Verified empirically (this exact profile
 * shape, a real `/usr/bin/sandbox-exec` child, on this task's own dev machine — see
 * sandbox.test.ts and tools-bash.test.ts): SBPL evaluates a profile's rules for a given operation
 * in FILE ORDER and the LAST matching rule wins, so placing this `(deny ...)` after the `(allow
 * file-write* (subpath ...))` block carves out that ONE exact file from an otherwise-writable
 * subpath, without touching anything else in it — a sibling file, or an entire OTHER subdirectory
 * like `.norma/memory/` (the MEMDIR), stays fully writable. Matches by filename alone, deliberately
 * never by directory. Each candidate path is realpath-canonicalized the same way the writable
 * `roots` themselves already are (`canon`, below) — for the near-universal case where the file
 * doesn't exist yet, `canon` gracefully falls through to the raw (already-canonical, since `roots`
 * is pre-canonicalized) concatenation, same graceful-fallback shape `canon` already has everywhere
 * else in this file.
 */
export function buildSeatbeltProfile(opts: SandboxOptions): string {
  const roots = [opts.cwd, ...(opts.writableRoots ?? [tmpdir()])].map(canon);
  const writeRules = roots.map((r) => `  (subpath "${sbplString(r)}")`).join("\n");
  const denyRulesFileRules = roots
    .map((r) => `(deny file-write* (literal "${sbplString(canon(join(r, ".norma", "permissions.local.json")))}"))`)
    .join("\n");
  const network = opts.allowNetwork ? "(allow network*)" : "(deny network*)";
  // Minimal mach services: deny blanket lookup so open/launchctl/osascript can't
  // ask a privileged, unsandboxed service to act out-of-band on our behalf.
  const machRules = [
    "com.apple.system.notification_center",
    "com.apple.system.logger",
    "com.apple.CoreServices.coreservicesd",
    // Resolves per-user temp/cache dir paths for confstr(_CS_DARWIN_USER_TEMP_DIR/_CACHE_DIR),
    // which xcrun/git-CLT-stubs (and swift, xcodebuild) call into on every invocation. Without
    // this, those tools still exit 0 but spam stderr with confstr()/DVT FSEvents noise that
    // reads like a real failure. Grants no spawning — safe, defense-in-depth stays intact.
    "com.apple.bsd.dirhelper",
  ].map((s) => `  (global-name "${sbplString(s)}")`).join("\n");
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup
${machRules})
(allow file-read*)
(allow file-write*
${writeRules})
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr") (path "/dev/dtracehelper"))
${network}
${denyRulesFileRules}
`;
}

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}
