// P9b-7: the daemon's brand is the SDK's OWN `WINTER_BRAND`, plus exactly three fields. Validated
// by the SDK's OWN `resolveBrand`, not by a mirror of its rules here: the rules live in one place
// (`sdk/src/brand.ts`) and a copy in a test would rot the first time the SDK tightened one.
import { afterEach, describe, expect, test } from "bun:test";
import {
  mcpToolName, resolveBrand, resolveWinterHome as sdkResolveWinterHome, WINTER_BRAND,
  type BrandProfile,
} from "@yanlinglabs/winter-agent-sdk";
import { keychainService } from "../../src/profile";
import { buildCoreBrand, CORE_BRAND } from "../../src/runtime-sdk/brand";
import { resolveWinterHome } from "../../src/winter-dir";

/** The fourteen fields `BrandProfile` has (surface map §1.5 / global constraints). */
const FIELDS: Array<keyof BrandProfile> = [
  "productName", "packageName", "homeDirName", "projectDirName", "instructionsFile", "envPrefix",
  "keychainService", "mcpServerName", "presetName", "processLabel", "codexOriginator",
  "tempRootName", "pluginManifestDir", "contactUrl",
];

/** The ONLY fields `buildCoreBrand` overrides from `WINTER_BRAND` (P9b-7's own contract). */
const OVERRIDDEN_FIELDS: ReadonlyArray<keyof BrandProfile> = ["packageName", "keychainService", "contactUrl"];

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

  // THE DELTA SET (P9b-7): under the "dist" profile, exactly `{packageName, contactUrl}` differ
  // from `WINTER_BRAND` — nothing else. Every other field is taken from the SDK's own defaults
  // verbatim, which is the whole point of spreading `WINTER_BRAND` rather than re-deriving it.
  test("dist: packageName and contactUrl differ from WINTER_BRAND, and NOTHING else does", () => {
    const dist = buildCoreBrand("dist");
    const differing = FIELDS.filter((f) => dist[f] !== WINTER_BRAND[f]);
    const expected: Array<keyof BrandProfile> = ["contactUrl", "packageName"];
    expect(differing.sort()).toEqual(expected.sort());
    expect(dist.packageName).toBe("winter-core");
    expect(dist.contactUrl).toBe("https://github.com/yanlingLabs/winter");
    expect(dist.keychainService).toBe(WINTER_BRAND.keychainService);
    expect(dist.keychainService).toBe("com.winter.core");
  });

  // Under "dev", `keychainService` ADDITIONALLY differs — the dev/dist split the SDK's own default
  // has no notion of, and `auth/secret-store.ts`'s `SERVICE` resolves the identical way.
  test("dev: additionally keychainService differs, at exactly com.winter.core.dev", () => {
    const dev = buildCoreBrand("dev");
    const differing = FIELDS.filter((f) => dev[f] !== WINTER_BRAND[f]);
    expect(differing.sort()).toEqual([...OVERRIDDEN_FIELDS].sort());
    expect(dev.keychainService).toBe("com.winter.core.dev");
    expect(dev.keychainService).toBe(keychainService("dev"));
    expect(resolveBrand(dev).ok).toBe(true);
  });

  test("mcpToolName produces the P8b-12 capability names", () => {
    expect(mcpToolName(CORE_BRAND, "x")).toBe("mcp__winter__x");
    expect(mcpToolName(CORE_BRAND, "sessions__list_sessions")).toBe("mcp__winter__sessions__list_sessions");
    expect(mcpToolName(CORE_BRAND, "computer__computer")).toBe("mcp__winter__computer__computer");
  });

  // P9b-7's own consequence: the daemon takes the SDK's `presetName` as-is (never overridden), and
  // it is the SDK's own value, not the bare brand token — see mode-options.ts's own consumer.
  test("presetName is the SDK's own winter_code, not the bare brand token", () => {
    expect(CORE_BRAND.presetName).toBe("winter_code");
  });

  test("envPrefix carries its trailing underscore (ENV_PREFIX_RE requires it)", () => {
    expect(CORE_BRAND.envPrefix).toBe("WINTER_");
    expect(resolveBrand({ ...CORE_BRAND, envPrefix: "WINTER" }).ok).toBe(false);
  });

  test("keychainService is profile-aware and equals the daemon's own", () => {
    expect(buildCoreBrand("dist").keychainService).toBe(keychainService("dist"));
    expect(buildCoreBrand("dev").keychainService).toBe(keychainService("dev"));
    // The default (what CORE_BRAND itself froze at module load) follows the process's profile.
    expect(CORE_BRAND.keychainService).toBe(keychainService());
    expect(CORE_BRAND.keychainService).toBe(keychainService(undefined));
  });

  // THE HOME ALIGNMENT (P9b-7's own point): a Winter-branded Winter session resolves its home from
  // the SAME env var and default core's own resolver does, so the daemon's home and Winter's home
  // are ONE directory. Asserted by comparing the SDK's own resolver (given CORE_BRAND) against
  // core's own `resolveWinterHome()` (`../winter-dir.ts`) under the SAME env, rather than by
  // duplicating the SDK's resolution rules here.
  describe("resolveWinterHome under CORE_BRAND equals core's own resolver", () => {
    const savedHome = process.env.WINTER_HOME;
    const savedProfile = process.env.WINTER_PROFILE;
    afterEach(() => {
      if (savedHome === undefined) delete process.env.WINTER_HOME; else process.env.WINTER_HOME = savedHome;
      if (savedProfile === undefined) delete process.env.WINTER_PROFILE; else process.env.WINTER_PROFILE = savedProfile;
    });

    test("under a temp WINTER_HOME", () => {
      delete process.env.WINTER_PROFILE;
      process.env.WINTER_HOME = "/tmp/some-winter-home-for-brand-test";
      expect(sdkResolveWinterHome(undefined, CORE_BRAND)).toBe(resolveWinterHome());
      expect(resolveWinterHome()).toBe("/tmp/some-winter-home-for-brand-test");
    });

    // Every real entry point sets `WINTER_HOME` and `WINTER_PROFILE` TOGETHER under the dev profile
    // (CLAUDE.md's own dev command: `WINTER_HOME=~/.winter-dev WINTER_PROFILE=dev …`) — so this is
    // the alignment that actually holds in production. NOT tested here: `WINTER_PROFILE=dev` ALONE,
    // with no explicit `WINTER_HOME`. Core's own `resolveWinterHome()` (`../winter-dir.ts`) reads
    // only `WINTER_HOME`, with no profile-derived `-dev` suffix of its own — a gap that predates
    // this rename (confirmed against this same file's own pre-rename ancestor, identically
    // profile-blind under its own old name) and is out of this lane's scope to fix; see the
    // report's concerns.
    test("under WINTER_PROFILE=dev with the matching explicit WINTER_HOME", () => {
      process.env.WINTER_HOME = "/tmp/some-winter-dev-home-for-brand-test";
      process.env.WINTER_PROFILE = "dev";
      expect(sdkResolveWinterHome(undefined, CORE_BRAND)).toBe(resolveWinterHome());
      expect(resolveWinterHome()).toBe("/tmp/some-winter-dev-home-for-brand-test");
    });
  });
});
