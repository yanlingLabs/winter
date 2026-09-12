import { describe, expect, test } from "bun:test";
import { RUNTIME_BUNDLE_LAYOUT, bundleRuntimePath, parseVersionsJson, winterSourceOf, type VersionsJson } from "../../src/runtime-sdk/bundle-layout";
import { REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";

const sha = "a".repeat(64);
const good: VersionsJson = {
  schema: 1, winterAgentSdk: REQUIRED_WINTER_AGENT_SDK, winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
  officialSdk: REQUIRED_CLAUDE_AGENT_SDK, claudeCode: "2.1.250", checksums: { winterPreSign: sha, claude: sha }, stagedAt: "2026-09-12T00:00:00Z",
};

describe("bundle-layout (P8d-1)", () => {
  test("the bundle rung is dirname(execPath) + the layout entry", () => {
    expect(bundleRuntimePath("/Applications/Norma.app/Contents/Resources/norma-core", "winter")).toBe("/Applications/Norma.app/Contents/Resources/runtimes/winter");
    expect(bundleRuntimePath("/x/Resources/norma-core", "claude")).toBe("/x/Resources/runtimes/claude-official/claude");
    expect(bundleRuntimePath("/x/Resources/norma-core", "versions")).toBe("/x/Resources/runtimes/claude-official/VERSIONS.json");
    expect(RUNTIME_BUNDLE_LAYOUT.root).toBe("runtimes");
  });
  test("parseVersionsJson accepts a record matching this build's pins", () => {
    expect(parseVersionsJson(JSON.stringify(good)).claudeCode).toBe("2.1.250");
  });
  test("parseVersionsJson refuses a pin mismatch, a bad checksum, and a bad schema", () => {
    expect(() => parseVersionsJson(JSON.stringify({ ...good, officialSdk: "0.3.251" }))).toThrow(/disagrees with this build's pins/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, checksums: { winterPreSign: "nope", claude: sha } }))).toThrow(/sha256/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, schema: 2 }))).toThrow(/schema/);
    expect(() => parseVersionsJson("{")).toThrow(/valid JSON/);
  });

  // P9a-8: VersionsJson.winterSource, the checksum equality's own provenance label.
  test("winterSourceOf defaults an absent field to checkout-build (an 8d-staged bundle predates this field)", () => {
    expect(winterSourceOf(good)).toBe("checkout-build");
    expect(winterSourceOf({ ...good, winterSource: "platform-package" })).toBe("platform-package");
    expect(winterSourceOf({ ...good, winterSource: "checkout-build" })).toBe("checkout-build");
  });
  test("parseVersionsJson accepts both winterSource spellings and preserves an absent field as absent", () => {
    expect(parseVersionsJson(JSON.stringify({ ...good, winterSource: "platform-package" })).winterSource).toBe("platform-package");
    expect(parseVersionsJson(JSON.stringify({ ...good, winterSource: "checkout-build" })).winterSource).toBe("checkout-build");
    expect(parseVersionsJson(JSON.stringify(good)).winterSource).toBeUndefined();
  });
  test("parseVersionsJson rejects any winterSource spelling other than the two", () => {
    expect(() => parseVersionsJson(JSON.stringify({ ...good, winterSource: "npm" }))).toThrow(/winterSource must be one of/);
    expect(() => parseVersionsJson(JSON.stringify({ ...good, winterSource: 1 }))).toThrow(/winterSource must be one of/);
  });
});
