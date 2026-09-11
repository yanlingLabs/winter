// The brand is validated by the SDK's OWN `resolveBrand`, not by a mirror of its rules here: the
// rules live in one place (`sdk/src/brand.ts`) and a copy in a test would rot the first time the
// SDK tightened one.
import { describe, expect, test } from "bun:test";
import { mcpToolName, resolveBrand, resolveWinterHome, WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { keychainService } from "../../src/profile";
import { buildNormaBrand, NORMA_BRAND } from "../../src/runtime-sdk/brand";

/** The fourteen fields `BrandProfile` has (surface map §1.5 / global constraints). */
const FIELDS: Array<keyof BrandProfile> = [
  "productName", "packageName", "homeDirName", "projectDirName", "instructionsFile", "envPrefix",
  "keychainService", "mcpServerName", "presetName", "processLabel", "codexOriginator",
  "tempRootName", "pluginManifestDir", "contactUrl",
];

describe("NORMA_BRAND", () => {
  test("all fourteen fields are present, string, and non-empty — and there are no others", () => {
    for (const f of FIELDS) {
      expect(typeof NORMA_BRAND[f]).toBe("string");
      expect(NORMA_BRAND[f].length).toBeGreaterThan(0);
    }
    // The count is pinned against WINTER_BRAND rather than a literal 14, so a future SDK field
    // makes this fail here (where the fix is one line) instead of at a child's first session.
    expect(Object.keys(NORMA_BRAND).sort()).toEqual(Object.keys(WINTER_BRAND).sort());
    expect(Object.keys(NORMA_BRAND).sort()).toEqual([...FIELDS].sort());
  });

  test("the SDK's own resolveBrand reports it valid", () => {
    const v = resolveBrand(NORMA_BRAND);
    expect(v.ok ? "" : v.reason).toBe(""); // the reason names the offending field when it is not ok
    expect(v.ok).toBe(true);
  });

  test("it is Norma's identity, not Winter's — every field differs where identity lives", () => {
    expect(NORMA_BRAND.productName).toBe("Norma");
    expect(NORMA_BRAND.homeDirName).toBe(".norma");
    expect(NORMA_BRAND.mcpServerName).toBe("norma");
    // CLAUDE.md hard rule: `originator: "norma"` is a deliberate ToS decision, never first-party.
    expect(NORMA_BRAND.codexOriginator).toBe("norma");
    expect(NORMA_BRAND.homeDirName).not.toBe(WINTER_BRAND.homeDirName);
    expect(NORMA_BRAND.mcpServerName).not.toBe(WINTER_BRAND.mcpServerName);
  });

  test("envPrefix carries its trailing underscore (ENV_PREFIX_RE requires it)", () => {
    expect(NORMA_BRAND.envPrefix).toBe("NORMA_");
    // The negative half: the Interfaces block's `"NORMA"` is refused by the SDK itself.
    expect(resolveBrand({ ...NORMA_BRAND, envPrefix: "NORMA" }).ok).toBe(false);
  });

  // P8b-12's literal. `mcpToolName` is TWO-arg on the installed SDK (`brand.d.ts:111`), so the
  // canonical `mcp__norma__<server>__<tool>` name is produced by joining the server key and the
  // tool with `__` in the single `tool` argument. Tasks 6-7's `capabilityToolName` must do the
  // same. Both forms are asserted so the shape is unambiguous in the record.
  test("mcpToolName produces the P8b-12 capability names", () => {
    expect(mcpToolName(NORMA_BRAND, "sessions__list_sessions")).toBe("mcp__norma__sessions__list_sessions");
    expect(mcpToolName(NORMA_BRAND, "list_sessions")).toBe("mcp__norma__list_sessions");
    expect(mcpToolName(NORMA_BRAND, "computer__computer")).toBe("mcp__norma__computer__computer");
  });

  test("keychainService is profile-aware and equals the daemon's own", () => {
    expect(buildNormaBrand("dist").keychainService).toBe(keychainService("dist"));
    expect(buildNormaBrand("dist").keychainService).toBe("com.norma.core");
    expect(buildNormaBrand("dev").keychainService).toBe(keychainService("dev"));
    expect(buildNormaBrand("dev").keychainService).toBe("com.norma.core.dev");
    // The default (what NORMA_BRAND itself froze at module load) follows the process's profile.
    expect(NORMA_BRAND.keychainService).toBe(keychainService());
    expect(resolveBrand(buildNormaBrand("dev")).ok).toBe(true);
  });

  // The module-load half of the rule above. `NORMA_BRAND` is `buildNormaBrand()` evaluated once at
  // import, and `keychainService()`'s own default parameter reads `NORMA_PROFILE` off `process.env`
  // at that moment — so a process started under the dev profile gets `com.norma.core.dev` in the
  // brand, by the same mechanism (and with the same set-it-before-the-import caveat) that
  // `auth/secret-store.ts`'s `SERVICE` has always had. Asserted through the equality above rather
  // than by spawning a second process: a subprocess spawn is not available in every sandbox this
  // suite runs in, and the identity `NORMA_BRAND.keychainService === keychainService()` is the
  // whole claim.
  test("the daemon's secret store and the brand name the SAME service", () => {
    expect(NORMA_BRAND.keychainService).toBe(keychainService(undefined));
  });

  // THE ALIGNMENT 8b rests on: a Norma-branded Winter session resolves its home from the daemon's
  // OWN variable, so `home` and `winterHome` are one directory (surface map §6.5).
  test("resolveWinterHome under this brand reads NORMA_HOME / NORMA_PROFILE", () => {
    expect(resolveWinterHome({ NORMA_HOME: "/x" }, NORMA_BRAND)).toBe("/x");
    // An explicit home wins over the dev profile, exactly as the daemon's own resolution does.
    expect(resolveWinterHome({ NORMA_HOME: "/x", NORMA_PROFILE: "dev" }, NORMA_BRAND)).toBe("/x");
    expect(resolveWinterHome({ NORMA_PROFILE: "dev" }, NORMA_BRAND).endsWith("/.norma-dev")).toBe(true);
    expect(resolveWinterHome({}, NORMA_BRAND).endsWith("/.norma")).toBe(true);
    // And it is NOT Winter's home — the G-13 failure mode this brand exists to prevent.
    expect(resolveWinterHome({ WINTER_HOME: "/w" }, NORMA_BRAND)).not.toBe("/w");
  });
});
