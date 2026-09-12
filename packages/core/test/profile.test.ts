import { describe, expect, test } from "bun:test";
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
});
