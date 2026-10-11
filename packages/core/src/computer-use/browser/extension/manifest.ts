// ComputerV2 Phase 2 — the native-messaging host manifests that tell each Chromium browser where `winter-browser-host`
// lives. dist: Winter.app (Release) writes `com.winter.browser.json` at every launch (its Swift twin,
// apple/Winter/Sources/BrowserExtension). dev: `bun run dev:helper` writes `com.winter.browser.dev.json` with this
// module after it builds and signs the dev helper. Tests: only into a temp `--user-data-dir`'s own NativeMessagingHosts.
//
// The rules both writers keep: a stable path (never a versioned one), written atomically (temp file + rename), only
// when the content differs, only into a browser whose support directory already exists, never deleting anything.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Each browser's user-level directory under `~/Library/Application Support/` (the manifest goes in its
 *  `NativeMessagingHosts/`). Kept equal to the Swift writer's list by a repo test. */
export const NATIVE_MESSAGING_BROWSER_DIRS: readonly string[] = [
  "Google/Chrome",
  "Google/Chrome Beta",
  "Google/Chrome Dev",
  "Google/Chrome Canary",
  "Chromium",
  "Microsoft Edge",
  "Microsoft Edge Beta",
  "Microsoft Edge Dev",
  "Microsoft Edge Canary",
  "BraveSoftware/Brave-Browser",
  "Vivaldi",
  "com.operasoftware.Opera",
  "Arc/User Data",
];

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export function hostManifest(i: { name: string; path: string; allowedOrigins: readonly string[] }): HostManifest {
  if (!i.path.startsWith("/")) throw new Error(`a host manifest's path must be absolute (got ${i.path})`);
  return { name: i.name, description: "Winter for Chrome", path: i.path, type: "stdio", allowed_origins: [...i.allowedOrigins] };
}

/** The file's bytes: two-space JSON plus a newline — the Swift writer produces the same text. */
export function hostManifestText(m: HostManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

export type ManifestWriteOutcome = "written" | "unchanged" | "skipped";

/**
 * Writes `<nmDir>/<name>.json` atomically unless it already holds exactly `text`. `nmDir` is created (one level);
 * nothing is ever deleted besides this call's own temp file.
 */
export function writeManifestInto(nmDir: string, m: HostManifest): Exclude<ManifestWriteOutcome, "skipped"> {
  const text = hostManifestText(m);
  const target = join(nmDir, `${m.name}.json`);
  try {
    if (readFileSync(target, "utf8") === text) return "unchanged";
  } catch { /* absent or unreadable: write it */ }
  mkdirSync(nmDir, { recursive: true });
  const tmp = join(nmDir, `.${m.name}.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return "written";
}

/**
 * Writes the manifest for every browser whose support directory exists under `supportRoot`
 * (`~/Library/Application Support` in production; a temp dir in tests). Returns each browser directory's outcome.
 */
export function writeHostManifests(supportRoot: string, m: HostManifest): { dir: string; outcome: ManifestWriteOutcome }[] {
  return NATIVE_MESSAGING_BROWSER_DIRS.map((dir) => {
    const browserDir = join(supportRoot, dir);
    if (!existsSync(browserDir)) return { dir, outcome: "skipped" as const };
    return { dir, outcome: writeManifestInto(join(browserDir, "NativeMessagingHosts"), m) };
  });
}
