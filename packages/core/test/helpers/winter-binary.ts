import { describe } from "bun:test";
import { existsSync } from "node:fs";
import { resolvePlatformPackageWinter } from "../../src/runtime-sdk/executable";
/** P8b-2 test contract: e2e tests that spawn a real `winter` child read WINTER_RUNTIME_EXECUTABLE.
 *  Unset → the describe block SKIPS (local runs without a build). WINTER_RUNTIME_REQUIRE_BINARY=1 (CI)
 *  → a missing binary is a FAILURE, so CI can never go green by skipping the proof. */
let warnedStale = false;
export function winterExecutableForTests(): string | undefined {
  const p = process.env.WINTER_RUNTIME_EXECUTABLE;
  if (p && existsSync(p)) return p;
  // P9a-9: with nothing explicit configured, the ladder's last rung — the installed platform
  // package (`bun install` brings it since the 0.0.5 pin) — is a real binary too, so the e2e
  // proofs run locally without a `dist/winter` build. Mirrors production resolution exactly.
  if (!p) {
    try {
      const fromPackage = resolvePlatformPackageWinter();
      if (fromPackage !== undefined) return fromPackage;
    } catch {
      // a version-mismatched package is not the pinned peer — fall through to the skip/refusal below
    }
  }
  if (process.env.WINTER_RUNTIME_REQUIRE_BINARY === "1") throw new Error(`WINTER_RUNTIME_REQUIRE_BINARY=1 but WINTER_RUNTIME_EXECUTABLE is ${p ? "missing on disk" : "unset"} and no platform package is installed`);
  // Review F-9: a STALE env var (a `dist/winter` that was cleaned away) otherwise skips exactly as
  // if nothing were configured — the dev thinks they are running the e2e proofs and they are not.
  // Warned once per process, not per describe block, so a suite with many of these says it once.
  if (p && !warnedStale) {
    warnedStale = true;
    console.warn(`[winter-binary] WINTER_RUNTIME_EXECUTABLE is set to ${p}, which does not exist — winter e2e blocks will SKIP. Run \`bun run build:winter\` or unset it.`);
  }
  return undefined;
}
export const describeWithWinterBinary = (name: string, fn: (bin: string) => void) => {
  const bin = winterExecutableForTests();
  if (!bin) return describe.skip(`${name} (WINTER_RUNTIME_EXECUTABLE unset)`, () => {});
  return describe(name, () => fn(bin));
};
