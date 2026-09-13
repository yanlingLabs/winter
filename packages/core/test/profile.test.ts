import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { keychainService, profileDisplayName, resolveWinterProfile } from "../src/profile";

describe("profile", () => {
  test("resolveWinterProfile: dev only on exact WINTER_PROFILE=dev", () => {
    expect(resolveWinterProfile({} as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveWinterProfile({ WINTER_PROFILE: "dev" } as NodeJS.ProcessEnv)).toBe("dev");
    expect(resolveWinterProfile({ WINTER_PROFILE: "prod" } as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveWinterProfile({ WINTER_PROFILE: "" } as NodeJS.ProcessEnv)).toBe("dist");
  });

  test("keychainService: dist literal unchanged, dev suffixed", () => {
    expect(keychainService("dist")).toBe("com.winter.core");
    expect(keychainService("dev")).toBe("com.winter.core.dev");
  });

  test("profileDisplayName", () => {
    expect(profileDisplayName("dist")).toBe("Winter");
    expect(profileDisplayName("dev")).toBe("Winter Dev");
  });

  // Test-keychain-isolation fix (P9c-15 guard): WINTER_KEYCHAIN_SERVICE overrides the returned
  // service ONLY for a non-default home. `test/preload.ts` sets this env var for the whole run, so
  // these tests save/restore it explicitly rather than relying on ambient state.
  describe("keychainService: WINTER_KEYCHAIN_SERVICE override (P9c-15 default-home guard)", () => {
    let prevOverride: string | undefined;
    beforeEach(() => { prevOverride = process.env.WINTER_KEYCHAIN_SERVICE; });
    afterEach(() => {
      if (prevOverride === undefined) delete process.env.WINTER_KEYCHAIN_SERVICE;
      else process.env.WINTER_KEYCHAIN_SERVICE = prevOverride;
    });

    test("ignored for the profile's own default home, even when set", () => {
      process.env.WINTER_KEYCHAIN_SERVICE = "com.acme.override";
      expect(keychainService("dist", join(homedir(), ".winter"))).toBe("com.winter.core");
      expect(keychainService("dev", join(homedir(), ".winter-dev"))).toBe("com.winter.core.dev");
    });

    test("honoured for a non-default (e.g. a test's temp) home", () => {
      process.env.WINTER_KEYCHAIN_SERVICE = "com.acme.override";
      expect(keychainService("dist", "/private/tmp/winter-test-home-xyz")).toBe("com.acme.override");
      expect(keychainService("dev", "/private/tmp/winter-test-home-xyz")).toBe("com.acme.override");
    });

    test("no override at all when the env var is unset, regardless of home", () => {
      delete process.env.WINTER_KEYCHAIN_SERVICE;
      expect(keychainService("dist", "/private/tmp/winter-test-home-xyz")).toBe("com.winter.core");
      expect(keychainService("dev", join(homedir(), ".winter-dev"))).toBe("com.winter.core.dev");
    });
  });
});
