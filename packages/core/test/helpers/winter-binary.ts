import { describe } from "bun:test";
import { existsSync } from "node:fs";
/** P8b-2 test contract: e2e tests that spawn a real `winter` child read NORMA_WINTER_EXECUTABLE.
 *  Unset → the describe block SKIPS (local runs without a build). NORMA_WINTER_REQUIRE_BINARY=1 (CI)
 *  → a missing binary is a FAILURE, so CI can never go green by skipping the proof. */
export function winterExecutableForTests(): string | undefined {
  const p = process.env.NORMA_WINTER_EXECUTABLE;
  if (p && existsSync(p)) return p;
  if (process.env.NORMA_WINTER_REQUIRE_BINARY === "1") throw new Error(`NORMA_WINTER_REQUIRE_BINARY=1 but NORMA_WINTER_EXECUTABLE is ${p ? "missing on disk" : "unset"}`);
  return undefined;
}
export const describeWithWinterBinary = (name: string, fn: (bin: string) => void) => {
  const bin = winterExecutableForTests();
  if (!bin) return describe.skip(`${name} (NORMA_WINTER_EXECUTABLE unset)`, () => {});
  return describe(name, () => fn(bin));
};
