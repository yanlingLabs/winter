import { realpathSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
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


/** Escape a string for embedding inside an SBPL `(regex #"...")` literal. */
function sbplRegexLiteral(p: string): string {
  return p.replace(/[\\^$.|?*+()\[\]{}]/g, "\\$&").replace(/"/g, '\\"');
}

/**
 * macOS's per-user temp directory (`/var/folders/<x>/<y>/T`), resolved the SAME way the C library
 * resolves it — `confstr(_CS_DARWIN_USER_TEMP_DIR)`, which `getconf DARWIN_USER_TEMP_DIR` exposes.
 *
 * Deliberately NOT `os.tmpdir()`: that reads `$TMPDIR`, and the one caller that matters (the bash
 * tool) OVERRIDES `$TMPDIR` for its child to a per-session scratch dir. We need the directory the
 * child's libc will actually use no matter what the environment says, which is exactly the
 * distinction that makes this rule necessary in the first place (see the profile comment below).
 *
 * Cached for the process: the value is fixed per user per boot, and this is on the path of every
 * sandboxed bash call. A failure to resolve degrades to `null` (rule simply omitted) rather than
 * throwing — a profile without this convenience rule is still a CORRECT profile.
 */
let darwinTempDirCache: string | null | undefined;
function darwinUserTempDir(): string | null {
  if (darwinTempDirCache !== undefined) return darwinTempDirCache;
  darwinTempDirCache = null;
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
      const raw = out.stdout?.trim();
      if (raw) darwinTempDirCache = canon(raw.replace(/\/+$/, ""));
    } catch { /* leave null */ }
  }
  return darwinTempDirCache;
}

/** Test seam: forget the cached per-user temp dir so a test can observe resolution again. */
export function __resetDarwinTempDirCacheForTests(): void {
  darwinTempDirCache = undefined;
}

/**
 * Build a macOS Seatbelt (SBPL) profile: deny-by-default, read anywhere,
 * write only under the given roots, network denied unless opted in.
 *
 * SP-approvals final review (composition hole, HIGH, defense-in-depth): EVERY writable root
 * (cwd + each of `writableRoots`) additionally gets an explicit `(deny file-write* (literal
 * "<root>/.norma/permissions.local.json"))` line, unconditionally — automatic for every caller,
 * with no opt-in flag to forget. This is the bash-invoked-write half of the same fix engine.ts's
 * dispatch loop applies to the write/edit TOOLS (`controlPlaneFileTarget`): a bash command like
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
 *
 * CC-parity Task 6.5 (controller-added): both the per-root literals and the any-depth regex now
 * cover two MORE control-plane filenames — `settings.json` and `settings.local.json`, the
 * `ProjectSettingsResolver` overlays Task 7 wires `permissions.allow` from. Same composition-hole
 * logic as above: engine.ts's write/edit-tool fence (`controlPlaneFileTarget`, renamed from
 * `permissionRulesFileTarget` in this same pass) only ever sees write/edit TOOL calls, so a
 * bash-invoked `echo '{"permissions":{"allow":["BashUnsandboxed(*:*)"]}}' >
 * .norma/settings.local.json` needs THIS seatbelt to be the one thing standing in its way. The two
 * new filenames get their own SEPARATE `(deny file-write* (regex ...))` lines — never combined via
 * alternation into one — mirroring `RULES_FILE_REGEX`'s own per-character case-class technique. See
 * `SETTINGS_FILE_REGEX`/`SETTINGS_LOCAL_FILE_REGEX` below.
 */
export function buildSeatbeltProfile(opts: SandboxOptions): string {
  const roots = [opts.cwd, ...(opts.writableRoots ?? [tmpdir()])].map(canon);
  const writeRules = roots.map((r) => `  (subpath "${sbplString(r)}")`).join("\n");
  // CC-parity Task 6.5: three control-plane filenames per root now, not just the rules store —
  // `settings.json`/`settings.local.json` join once Task 7 makes them rule-bearing (see this
  // function's own doc comment above). `flatMap` over the cross product (roots × filenames) keeps
  // this a single joined block of literal denies, same shape as before, just wider.
  const CONTROL_PLANE_FILES = ["permissions.local.json", "settings.json", "settings.local.json"];
  const denyRulesFileRules = roots
    .flatMap((r) => CONTROL_PLANE_FILES.map((f) => `(deny file-write* (literal "${sbplString(canon(join(r, ".norma", f)))}"))`))
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
  // CC-parity Task 6.5: the same NESTED-store hole applies to the two settings overlays once a
  // broad `Edit(<parent>)` grant is in force — `<parent>/projB/.norma/settings.local.json` sits
  // inside a writable subpath with no literal deny for it either. Two SEPARATE regex deny lines
  // (never one combined via alternation — only plain per-character char-class regexes are verified
  // against real sandbox-exec, see the comment above), same per-character case-folding technique as
  // `RULES_FILE_REGEX`. The `$`-anchored suffixes are disjoint by construction — `settings.json`
  // cannot match a path ending in `settings.local.json` (it ends in `.local.json`, not directly in
  // `settings` + `.json`) and vice versa — so each file gets exactly one of these two regexes, never
  // both.
  const SETTINGS_FILE_REGEX = String.raw`/\.[Nn][Oo][Rr][Mm][Aa]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Jj][Ss][Oo][Nn]$`;
  const SETTINGS_LOCAL_FILE_REGEX = String.raw`/\.[Nn][Oo][Rr][Mm][Aa]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$`;
  const denySettingsFileRegex = `(deny file-write* (regex #"${SETTINGS_FILE_REGEX}"))`;
  const denySettingsLocalFileRegex = `(deny file-write* (regex #"${SETTINGS_LOCAL_FILE_REGEX}"))`;
  // macOS `mktemp(1)` — and anything else calling `confstr(_CS_DARWIN_USER_TEMP_DIR)` — writes to
  // the PER-USER temp dir (`/var/folders/<x>/<y>/T`) and IGNORES `$TMPDIR` entirely. Measured, not
  // assumed: with `TMPDIR` correctly exported into the sandboxed child, bare `mktemp` still landed
  // on `/var/folders/.../T/tmp.XXXXXXXX` and died with `Operation not permitted`, which is enough to
  // fail an ordinary `git commit` outright whenever a hook (a global `core.hooksPath` one, say)
  // shells out to `mktemp`. Both arms run against a real `/usr/bin/sandbox-exec`.
  //
  // ⚠️ DIRECT CHILDREN ONLY — a `(subpath ...)` here would be a REAL fence regression, not a
  // convenience. The per-user temp dir is where every other app on the machine keeps its own temp
  // state, and (this is the load-bearing part) it is also where the bash tool's own tests build the
  // "outside" directories they assert are UNWRITABLE: `CANNOT write outside the session cwd` writes
  // to `<tmp>/norma-bash-XXXX/escaped.txt`. That is two levels down, so `[^/]+$` leaves it denied,
  // while `mktemp`'s own `<tmp>/tmp.XXXXXXXX` — one level — is allowed. The rule buys exactly the
  // idiom that was broken and nothing else: creating a temp FILE, and writing to it.
  // `mktemp -d` still yields an unwritable directory; `$TMPDIR` (the per-session scratch, fully
  // writable) remains the right answer for anything that needs a temp TREE.
  //
  // Placed BEFORE the control-plane denies below on purpose: SBPL is last-match-wins, so those
  // denies continue to override this allow. (No control-plane file can be a direct child anyway —
  // they all sit under a `.norma/` component — but the ordering is what makes that structural
  // rather than incidental.)
  const perUserTemp = darwinUserTempDir();
  const allowDarwinTempFiles = perUserTemp
    ? `(allow file-write* (regex #"^${sbplRegexLiteral(perUserTemp)}/[^/]+$"))`
    : "";

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
${allowDarwinTempFiles}
${network}
${denyRulesFileRules}
${denyRulesFileRegex}
${denySettingsFileRegex}
${denySettingsLocalFileRegex}
`;
}

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}
