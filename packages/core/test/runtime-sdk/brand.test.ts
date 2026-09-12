// The brand is validated by the SDK's OWN `resolveBrand`, not by a mirror of its rules here: the
// rules live in one place (`sdk/src/brand.ts`) and a copy in a test would rot the first time the
// SDK tightened one.
import { describe, expect, test } from "bun:test";
import { mcpToolName, resolveBrand, resolveWinterHome, WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { keychainService } from "../../src/profile";
import { buildCoreBrand, CORE_BRAND } from "../../src/runtime-sdk/brand";

/** The fourteen fields `BrandProfile` has (surface map §1.5 / global constraints). */
const FIELDS: Array<keyof BrandProfile> = [
  "productName", "packageName", "homeDirName", "projectDirName", "instructionsFile", "envPrefix",
  "keychainService", "mcpServerName", "presetName", "processLabel", "codexOriginator",
  "tempRootName", "pluginManifestDir", "contactUrl",
];

describe("CORE_BRAND", () => {
  test("all fourteen fields are present, string, and non-empty — and there are no others", () => {
    for (const f of FIELDS) {
      expect(typeof CORE_BRAND[f]).toBe("string");
      expect(CORE_BRAND[f].length).toBeGreaterThan(0);
    }
    // The count is pinned against WINTER_BRAND rather than a literal 14, so a future SDK field
    // makes this fail here (where the fix is one line) instead of at a child's first session.
    expect(Object.keys(CORE_BRAND).sort()).toEqual(Object.keys(WINTER_BRAND).sort());
    expect(Object.keys(CORE_BRAND).sort()).toEqual([...FIELDS].sort());
  });

  test("the SDK's own resolveBrand reports it valid", () => {
    const v = resolveBrand(CORE_BRAND);
    expect(v.ok ? "" : v.reason).toBe(""); // the reason names the offending field when it is not ok
    expect(v.ok).toBe(true);
  });

  test("it is Winter's identity, not Winter's — every field differs where identity lives", () => {
    expect(CORE_BRAND.productName).toBe("Winter");
    expect(CORE_BRAND.homeDirName).toBe(".winter");
    expect(CORE_BRAND.mcpServerName).toBe("winter");
    // CLAUDE.md hard rule: `originator: "winter"` is a deliberate ToS decision, never first-party.
    expect(CORE_BRAND.codexOriginator).toBe("winter");
    expect(CORE_BRAND.homeDirName).not.toBe(WINTER_BRAND.homeDirName);
    expect(CORE_BRAND.mcpServerName).not.toBe(WINTER_BRAND.mcpServerName);
  });

  test("envPrefix carries its trailing underscore (ENV_PREFIX_RE requires it)", () => {
    expect(CORE_BRAND.envPrefix).toBe("WINTER_");
    // The negative half: the Interfaces block's `"WINTER"` is refused by the SDK itself.
    expect(resolveBrand({ ...CORE_BRAND, envPrefix: "WINTER" }).ok).toBe(false);
  });

  // P8b-12's literal. `mcpToolName` is TWO-arg on the installed SDK (`brand.d.ts:111`), so the
  // canonical `mcp__winter__<server>__<tool>` name is produced by joining the server key and the
  // tool with `__` in the single `tool` argument. Tasks 6-7's `capabilityToolName` must do the
  // same. Both forms are asserted so the shape is unambiguous in the record.
  test("mcpToolName produces the P8b-12 capability names", () => {
    expect(mcpToolName(CORE_BRAND, "sessions__list_sessions")).toBe("mcp__winter__sessions__list_sessions");
    expect(mcpToolName(CORE_BRAND, "list_sessions")).toBe("mcp__winter__list_sessions");
    expect(mcpToolName(CORE_BRAND, "computer__computer")).toBe("mcp__winter__computer__computer");
  });

  test("keychainService is profile-aware and equals the daemon's own", () => {
    expect(buildCoreBrand("dist").keychainService).toBe(keychainService("dist"));
    expect(buildCoreBrand("dist").keychainService).toBe("com.winter.core");
    expect(buildCoreBrand("dev").keychainService).toBe(keychainService("dev"));
    expect(buildCoreBrand("dev").keychainService).toBe("com.winter.core.dev");
    // The default (what CORE_BRAND itself froze at module load) follows the process's profile.
    expect(CORE_BRAND.keychainService).toBe(keychainService());
    expect(resolveBrand(buildCoreBrand("dev")).ok).toBe(true);
  });

  // The module-load half of the rule above. `CORE_BRAND` is `buildCoreBrand()` evaluated once at
  // import, and `keychainService()`'s own default parameter reads `WINTER_PROFILE` off `process.env`
  // at that moment — so a process started under the dev profile gets `com.winter.core.dev` in the
  // brand, by the same mechanism (and with the same set-it-before-the-import caveat) that
  // `auth/secret-store.ts`'s `SERVICE` has always had. Asserted through the equality above rather
  // than by spawning a second process: a subprocess spawn is not available in every sandbox this
  // suite runs in, and the identity `CORE_BRAND.keychainService === keychainService()` is the
  // whole claim.
  test("the daemon's secret store and the brand name the SAME service", () => {
    expect(CORE_BRAND.keychainService).toBe(keychainService(undefined));
  });

  // THE ALIGNMENT 8b rests on: a Winter-branded Winter session resolves its home from the daemon's
  // OWN variable, so `home` and `winterHome` are one directory (surface map §6.5).
  test("resolveWinterHome under this brand reads WINTER_HOME / WINTER_PROFILE", () => {
    expect(resolveWinterHome({ WINTER_HOME: "/x" }, CORE_BRAND)).toBe("/x");
    // An explicit home wins over the dev profile, exactly as the daemon's own resolution does.
    expect(resolveWinterHome({ WINTER_HOME: "/x", WINTER_PROFILE: "dev" }, CORE_BRAND)).toBe("/x");
    expect(resolveWinterHome({ WINTER_PROFILE: "dev" }, CORE_BRAND).endsWith("/.winter-dev")).toBe(true);
    expect(resolveWinterHome({}, CORE_BRAND).endsWith("/.winter")).toBe(true);
    // And it is NOT Winter's home — the G-13 failure mode this brand exists to prevent.
    expect(resolveWinterHome({ WINTER_HOME: "/w" }, CORE_BRAND)).not.toBe("/w");
  });
});
