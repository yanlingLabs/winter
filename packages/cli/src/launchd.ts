import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolveNormaProfile, type NormaProfile } from "@norma/core";

/** Kept ONLY for the legacy teardown of the historical dist agent (`migrateFromLaunchdAgent`
 *  below) — never used for new installs. Active call sites derive the label from the current
 *  profile via `launchdLabel()` instead. */
export const LAUNCHD_LABEL = "com.norma.core";

/** Resolves the profile at CALL time (default param, not a module-level snapshot) so a settings
 *  change mid-process — or simply different callers under different envs — is always honored. */
export function launchdLabel(profile: NormaProfile = resolveNormaProfile()): string {
  return profile === "dev" ? "com.norma.core.dev" : "com.norma.core";
}

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${launchdLabel()}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(opts: { binaryPath: string; normaHome: string; profile?: NormaProfile }): string {
  const home = xmlEscape(opts.normaHome);
  const profile = opts.profile ?? resolveNormaProfile();
  const label = launchdLabel(profile);
  // DD branch review (I3): a launchd-installed DEV daemon must carry NORMA_PROFILE=dev into its
  // environment, or `packages/core/src/auth/secret-store.ts`'s module-load-time
  // `keychainService()` resolves to the DIST literal (`com.norma.core`) despite running out of
  // `~/.norma-dev` — silent credential cross-contamination between profiles. The dist plist must
  // stay BYTE-IDENTICAL to before this fix (no new key, no whitespace drift) — only "dev" adds
  // the extra `<key>`/`<string>` pair to the EnvironmentVariables dict.
  const envVars = profile === "dev"
    ? `<dict><key>NORMA_HOME</key><string>${home}</string><key>NORMA_PROFILE</key><string>dev</string></dict>`
    : `<dict><key>NORMA_HOME</key><string>${home}</string></dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.binaryPath)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  ${envVars}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(join(opts.normaHome, "logs", "core.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(opts.normaHome, "logs", "core.err.log"))}</string>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text() + await new Response(proc.stderr).text();
  return { ok: (await proc.exited) === 0, out };
}

export async function installDaemon(binaryPath: string, normaHome: string): Promise<void> {
  writeFileSync(plistPath(), renderPlist({ binaryPath, normaHome }));
  const uid = process.getuid!();
  await launchctl("bootout", `gui/${uid}/${launchdLabel()}`); // ignore failures: may not be loaded
  const res = await launchctl("bootstrap", `gui/${uid}`, plistPath());
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.out}`);
}

export async function uninstallDaemon(): Promise<void> {
  await launchctl("bootout", `gui/${process.getuid!()}/${launchdLabel()}`);
  if (existsSync(plistPath())) unlinkSync(plistPath());
}

export async function daemonStatus(): Promise<string> {
  const res = await launchctl("print", `gui/${process.getuid!()}/${launchdLabel()}`);
  return res.ok ? "loaded" : "not loaded";
}

/** Injectable seams for `migrateFromLaunchdAgent` — real filesystem/launchctl by default, fakes in
 * tests. Never touches a real user's home directory or launchd from a test process. */
export interface MigrateLaunchdDeps {
  plistPath?: string;
  exists?: (path: string) => boolean;
  remove?: (path: string) => void;
  bootout?: (label: string) => Promise<void>;
}

/** Lifecycle T4: tears down the OLD `com.norma.core` launchd agent (superseded by the app's
 * `DaemonSupervisor` embedding norma-core directly). A leftover `KeepAlive` agent would otherwise
 * relaunch a daemon the app just killed, defeating the app↔daemon lifecycle coupling entirely — so
 * this must run before/at app-driven daemon supervision starts. No-op if the plist was never
 * installed (fresh installs, or a machine already migrated). NEVER throws: a failed bootout/unlink
 * (e.g. permissions, already gone) must not block the app from starting. */
export async function migrateFromLaunchdAgent(deps: MigrateLaunchdDeps = {}): Promise<void> {
  // Deliberately NOT `plistPath()` — that now resolves the CURRENT profile's label/path, but this
  // teardown targets the historical dist-only agent, which predates profiles and was always filed
  // under the literal `com.norma.core` regardless of what profile is running today (mirrors the
  // Swift `LaunchdMigrationDeps.live` hardcoding the same literal independently).
  const path = deps.plistPath ?? join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? unlinkSync;
  const bootout = deps.bootout ?? (async (label: string) => {
    await launchctl("bootout", `gui/${process.getuid!()}/${label}`);
  });
  try {
    if (!exists(path)) return; // never installed (or already migrated) — nothing to do
    await bootout(LAUNCHD_LABEL);
    remove(path);
  } catch (error) {
    console.error(`[launchd] migrateFromLaunchdAgent failed (non-fatal): ${error}`);
  }
}
