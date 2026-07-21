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
 *
 * SP-policies whole-branch review (Item 1, HIGH): those per-root literals only cover a store
 * DIRECTLY under a root; a broad `Edit(<parent>)` grant makes a NESTED store
 * (`<parent>/projB/.norma/permissions.local.json`) writable. An additional `(deny file-write*
 * (regex ...))` line — placed after the literals, matching `<any>/.norma/permissions.local.json` at ANY
 * depth, case-folded per character (SBPL has no working `(?i)`) — closes that. See the inline
 * comment on `RULES_FILE_REGEX` below for the real-`sandbox-exec` verification of both facts.
 */
export function buildSeatbeltProfile(opts: SandboxOptions): string {
  const roots = [opts.cwd, ...(opts.writableRoots ?? [tmpdir()])].map(canon);
  const writeRules = roots.map((r) => `  (subpath "${sbplString(r)}")`).join("\n");
  const denyRulesFileRules = roots
    .map((r) => `(deny file-write* (literal "${sbplString(canon(join(r, ".norma", "permissions.local.json")))}"))`)
    .join("\n");
  // SP-policies whole-branch review (Item 1, HIGH): the per-root literal denies above only cover a
  // rules store DIRECTLY under a writable root (`<root>/.norma/permissions.local.json`). A broad
  // `Edit(<parent>)` grant makes `<parent>` a writable root, so a NESTED store —
  // `<parent>/projB/.norma/permissions.local.json` — sat inside a writable subpath with no literal
  // deny for it, and sandboxed bash could write it (minting a sibling project's rules). This regex
  // deny closes that: it matches any path ending in `/.norma/permissions.local.json` at ANY nesting
  // depth. Case-folded per character on purpose — SBPL's regex engine does NOT honor an inline
  // `(?i)` flag (verified against a real `/usr/bin/sandbox-exec`: with `(?i)` the write sailed
  // straight through; with explicit `[Nn]`-style character classes it was denied), and the macOS
  // default volume is case-insensitive so `.NORMA/Permissions.Local.json` reaches the SAME file the
  // reader opens. It is a REGEX rule, never a `(subpath ...)` blanket — a sibling file, or the whole
  // `.norma/memory/` MEMDIR, at any depth, stays writable (filename-specific, same as the literals).
  const RULES_FILE_REGEX = String.raw`/\.[Nn][Oo][Rr][Mm][Aa]/[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$`;
  const denyRulesFileRegex = `(deny file-write* (regex #"${RULES_FILE_REGEX}"))`;
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
${denyRulesFileRegex}
`;
}

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}
