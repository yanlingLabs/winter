// ComputerV2 (2026-10-08, the daemon review's C2) — the bundle id of an app the script named, resolved IN THE
// DAEMON and without launching anything, so policy always decides BEFORE the helper's `target.bind` (which
// launches a non-running app and shows its mirror). The controller's ruling: an app is never launched or bound
// before policy has resolved its bundle id.
//
//   - a PATH (`/Applications/Notes.app`, `~/Apps/X.app`) → its `Contents/Info.plist` `CFBundleIdentifier`, read
//     with `/usr/bin/plutil` (binary and XML plists alike). Unreadable, or not a bundle identifier → refused.
//   - a BUNDLE ID the helper's `apps.list` did not name → LaunchServices' own record of it
//     (`LSCopyApplicationURLsForBundleIdentifier`, `auth/keychain-ffi.ts`) — a lookup, never a launch.
//   - a NAME `apps.list` did not name → refused: a bare name has no identity the daemon can check.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { applicationPathsForBundleId } from "../auth/keychain-ffi";

export interface ResolvedApp { bundleId: string; name: string; path?: string }

export interface AppResolver {
  /** The app bundle at `path`, by its Info.plist — undefined when it cannot be read. */
  fromPath(path: string): ResolvedApp | undefined;
  /** A bundle id LaunchServices knows — undefined when it knows none. */
  fromBundleId(bundleId: string): ResolvedApp | undefined;
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;

/** Does the script's `app` argument name a path (rather than a name or a bundle id)? */
export function isAppPath(app: string): boolean {
  return app.startsWith("/") || app.startsWith("~/") || app.startsWith("./") || app.startsWith("../") || app.includes("/");
}

/** Does `target` name a document to open (a file path that is not an .app, or a URL) rather than an app? */
export function isDocumentTarget(target: string): boolean {
  const t = target.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|tel|sms|facetime):/i.test(t)) return true; // a URL scheme
  if (t.startsWith("/") || t.startsWith("~/") || t.startsWith("./") || t.startsWith("../") || t.includes("/")) {
    return !/\.app\/?$/i.test(t); // a path, but an .app bundle is an app to bind
  }
  return false;
}

/** Does it look like a reverse-DNS bundle identifier? */
export function isBundleIdShaped(app: string): boolean {
  return BUNDLE_ID.test(app) && !app.includes(" ");
}

function expand(path: string): string {
  const p = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(p) ? p : resolve("/", p);
}

function readPlist(plistPath: string): Record<string, unknown> | undefined {
  const r = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export const systemAppResolver: AppResolver = {
  fromPath(path) {
    const appPath = expand(path);
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    const bundleId = plist?.CFBundleIdentifier;
    if (typeof bundleId !== "string" || !isBundleIdShaped(bundleId)) return undefined;
    const display = plist?.CFBundleDisplayName ?? plist?.CFBundleName;
    const name = typeof display === "string" && display.trim().length > 0 ? display.trim() : basename(appPath).replace(/\.app$/i, "");
    return { bundleId, name, path: appPath };
  },
  fromBundleId(bundleId) {
    if (!isBundleIdShaped(bundleId)) return undefined;
    let paths: string[];
    try { paths = applicationPathsForBundleId(bundleId); } catch { return undefined; }
    for (const p of paths) {
      const hit = systemAppResolver.fromPath(p);
      if (hit !== undefined && hit.bundleId.toLowerCase() === bundleId.toLowerCase()) return hit;
    }
    return undefined;
  },
};
