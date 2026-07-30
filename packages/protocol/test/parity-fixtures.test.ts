import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildCleanerVectorsFixture, buildDangerousDomainsFixture, CLEANER_VECTOR_INPUTS } from "../scripts/parity-fixtures";

/**
 * Chat Slice D, Task 4 — the freshness/drift tripwire for the two cross-language parity fixtures
 * (`fixtures/dangerous-domains.json`, `fixtures/cleaner-vectors.json`), mirroring the shape of the
 * existing Swift-side fixture-count tripwire (`RoundTripTests.fixtureURLs()`'s `count == 56`
 * assertion): both call the SAME `parity-fixtures.ts` functions the generator itself calls, so a
 * fixture on disk that disagrees with what those functions compute RIGHT NOW means real drift —
 * `packages/core`'s `SHIPPED_DANGEROUS_DOMAINS`/`htmlToText`/`renderLines` changed (or the vector
 * list changed) without a `pnpm protocol:generate` re-run — never two hand-maintained copies
 * quietly disagreeing with each other.
 */
const fixDir = join(import.meta.dir, "..", "generated", "fixtures");

describe("cross-language parity fixtures (Chat Slice D, Task 4): regeneration freshness", () => {
  test("dangerous-domains.json is byte-identical to a fresh build from the live SHIPPED_DANGEROUS_DOMAINS", () => {
    const committed = readFileSync(join(fixDir, "dangerous-domains.json"), "utf8");
    const fresh = JSON.stringify(buildDangerousDomainsFixture(), null, 2);
    expect(committed).toBe(fresh);
  });

  test("cleaner-vectors.json is byte-identical to a fresh run of the live htmlToText+renderLines", () => {
    const committed = readFileSync(join(fixDir, "cleaner-vectors.json"), "utf8");
    const fresh = JSON.stringify(buildCleanerVectorsFixture(), null, 2);
    expect(committed).toBe(fresh);
  });

  test("cleaner-vectors.json covers at least 12 vectors", () => {
    expect(CLEANER_VECTOR_INPUTS.length).toBeGreaterThanOrEqual(12);
  });

  test("the two accepted linearization-divergence-class regression inputs (web.ts's PRICE OF LINEARITY comment) are present verbatim", () => {
    const htmls = CLEANER_VECTOR_INPUTS.map((v) => v.html);
    expect(htmls.some((h) => h.includes("<h3<h2>"))).toBe(true);
    expect(htmls.some((h) => h.includes('<a href="href=">'))).toBe(true);
  });

  test("an empty page and a >20k-char page are both covered (cap behavior)", () => {
    expect(CLEANER_VECTOR_INPUTS.some((v) => v.html === "")).toBe(true);
    expect(CLEANER_VECTOR_INPUTS.some((v) => v.html.length > 20_000)).toBe(true);
  });

  // Guards the generate.ts sync-selectivity fix (see its own comment): these two new fixtures live
  // in the SAME fixDir as the 56 SessionEvent fixtures, but must never be swept into the Swift
  // NormaProtocol test bundle — RoundTripTests.swift decodes EVERY .json file it finds there as a
  // SessionEvent and hard-asserts an exact count of 56.
  test("did not leak into the Swift-synced fixture bundle, which still has exactly 56 files", () => {
    const swiftFixDir = join(import.meta.dir, "..", "..", "..", "apple", "NormaProtocol", "Tests", "NormaProtocolTests", "Fixtures");
    const swiftFiles = readdirSync(swiftFixDir).filter((f) => f.endsWith(".json"));
    expect(swiftFiles.length).toBe(56);
    expect(swiftFiles).not.toContain("dangerous-domains.json");
    expect(swiftFiles).not.toContain("cleaner-vectors.json");
  });
});
