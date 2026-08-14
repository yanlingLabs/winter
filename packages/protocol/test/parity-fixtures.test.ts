import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildCleanerVectorsFixture, buildDangerousDomainsFixture, CLEANER_VECTOR_INPUTS } from "../scripts/parity-fixtures";

/**
 * Chat Slice D, Task 4 — the freshness/drift tripwire for the two cross-language parity fixtures
 * (`fixtures/dangerous-domains.json`, `fixtures/cleaner-vectors.json`), mirroring the shape of the
 * existing Swift-side fixture-count tripwire (`RoundTripTests.fixtureURLs()`'s exact-count
 * assertion — 65 as of B2 T2; check that file rather than trusting a number restated here,
 * it has drifted twice): both call the SAME `parity-fixtures.ts` functions the generator itself
 * calls, so a
 * fixture on disk that disagrees with what those functions compute RIGHT NOW means real drift —
 * `packages/core`'s `SHIPPED_DANGEROUS_DOMAINS`/`htmlToText` changed (or the vector list changed)
 * without a `pnpm protocol:generate` re-run — never two hand-maintained copies quietly disagreeing
 * with each other.
 *
 * `cleaner-vectors.json`'s `lines` is RAW `htmlToText` output (Task 4 review fix, Important-1) —
 * never `renderLines`' numbered/headered presentation string, which Task 6's Swift
 * `htmlToText(_ html: String) -> [String]` was never asked to reproduce.
 */
const fixDir = join(import.meta.dir, "..", "generated", "fixtures");

describe("cross-language parity fixtures (Chat Slice D, Task 4): regeneration freshness", () => {
  test("dangerous-domains.json is byte-identical to a fresh build from the live SHIPPED_DANGEROUS_DOMAINS", () => {
    const committed = readFileSync(join(fixDir, "dangerous-domains.json"), "utf8");
    const fresh = JSON.stringify(buildDangerousDomainsFixture(), null, 2);
    expect(committed).toBe(fresh);
  });

  test("cleaner-vectors.json is byte-identical to a fresh run of the live htmlToText", () => {
    const committed = readFileSync(join(fixDir, "cleaner-vectors.json"), "utf8");
    const fresh = JSON.stringify(buildCleanerVectorsFixture(), null, 2);
    expect(committed).toBe(fresh);
  });

  // Task 4 review regression guard (Important-1): every vector's `lines` must be RAW htmlToText
  // output, never renderLines' numbered ("N→text") presentation format — a plain "N→" prefix or a
  // "(lines X-Y of Z)" header would mean the presentation-layer round-trip crept back in.
  test("no vector's lines carry renderLines' numbering/header presentation format", () => {
    for (const vector of buildCleanerVectorsFixture()) {
      for (const line of vector.lines) {
        expect(line).not.toMatch(/^\d+→/);
      }
      expect(vector.lines[0] ?? "").not.toMatch(/^Fixture \(lines? /);
    }
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
  // in the SAME fixDir as the 67 SessionEvent fixtures, but must never be swept into the Swift
  // NormaProtocol test bundle — RoundTripTests.swift decodes EVERY .json file it finds there as a
  // SessionEvent and hard-asserts an exact count (panel-shell T3: 58 → 63, five panel variants;
  // B2 T2: 63 → 65, two more panel_command shapes; diff-tabs Task 3: 65 → 67, two more diff-tab
  // fixtures). THIS assertion tracks the count on disk, so it moves in Task 3's own commit; the
  // Swift LITERAL in RoundTripTests.swift is a separate, later edit — diff-tabs plan Task 4 owns it
  // and `swift test` is red between the two commits by design (Task 4's brief says so explicitly).
  test("did not leak into the Swift-synced fixture bundle, which now has exactly 67 files", () => {
    const swiftFixDir = join(import.meta.dir, "..", "..", "..", "apple", "NormaProtocol", "Tests", "NormaProtocolTests", "Fixtures");
    const swiftFiles = readdirSync(swiftFixDir).filter((f) => f.endsWith(".json"));
    expect(swiftFiles.length).toBe(67);
    expect(swiftFiles).not.toContain("dangerous-domains.json");
    expect(swiftFiles).not.toContain("cleaner-vectors.json");
  });
});
