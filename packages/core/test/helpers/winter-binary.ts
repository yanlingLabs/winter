import { describe } from "bun:test";
import { existsSync } from "node:fs";
/** P8b-2 test contract: e2e tests that spawn a real `winter` child read NORMA_WINTER_EXECUTABLE.
 *  Unset → the describe block SKIPS (local runs without a build). NORMA_WINTER_REQUIRE_BINARY=1 (CI)
 *  → a missing binary is a FAILURE, so CI can never go green by skipping the proof. */
let warnedStale = false;
export function winterExecutableForTests(): string | undefined {
  const p = process.env.NORMA_WINTER_EXECUTABLE;
  if (p && existsSync(p)) return p;
  if (process.env.NORMA_WINTER_REQUIRE_BINARY === "1") throw new Error(`NORMA_WINTER_REQUIRE_BINARY=1 but NORMA_WINTER_EXECUTABLE is ${p ? "missing on disk" : "unset"}`);
  // Review F-9: a STALE env var (a `dist/winter` that was cleaned away) otherwise skips exactly as
  // if nothing were configured — the dev thinks they are running the e2e proofs and they are not.
  // Warned once per process, not per describe block, so a suite with many of these says it once.
  if (p && !warnedStale) {
    warnedStale = true;
    console.warn(`[winter-binary] NORMA_WINTER_EXECUTABLE is set to ${p}, which does not exist — winter e2e blocks will SKIP. Run \`bun run build:winter\` or unset it.`);
  }
  return undefined;
}
export const describeWithWinterBinary = (name: string, fn: (bin: string) => void) => {
  const bin = winterExecutableForTests();
  if (!bin) return describe.skip(`${name} (NORMA_WINTER_EXECUTABLE unset)`, () => {});
  return describe(name, () => fn(bin));
};
