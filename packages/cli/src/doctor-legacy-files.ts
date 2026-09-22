// A3: `winter doctor`'s legacy-files line — the same one line the daemon logs at boot when the home
// still holds top-level files an earlier Migration B copied and nothing reads (`mcp.json`,
// `tools.json`, …). Its own module so it is testable without running the whole `doctor` command,
// whose migration section reads the LEGACY Keychain service (no test may touch a real Keychain).
import { describeDeadLegacyFiles, findDeadLegacyFiles } from "@yanlinglabs/winter-core";

/** The line, or `undefined` when there is nothing to report. Never throws: `doctor` must not crash
 *  on a diagnostic. Names files and a server count only — never file contents. */
export function legacyFilesDoctorLine(home: string): string | undefined {
  try {
    return describeDeadLegacyFiles(findDeadLegacyFiles(home), home);
  } catch {
    return undefined;
  }
}
