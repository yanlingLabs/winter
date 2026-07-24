import { describe, expect, test } from "bun:test";
import { keychainService, profileDisplayName, resolveNormaProfile } from "../src/profile";

describe("profile", () => {
  test("resolveNormaProfile: dev only on exact NORMA_PROFILE=dev", () => {
    expect(resolveNormaProfile({} as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveNormaProfile({ NORMA_PROFILE: "dev" } as NodeJS.ProcessEnv)).toBe("dev");
    expect(resolveNormaProfile({ NORMA_PROFILE: "prod" } as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveNormaProfile({ NORMA_PROFILE: "" } as NodeJS.ProcessEnv)).toBe("dist");
  });

  test("keychainService: dist literal unchanged, dev suffixed", () => {
    expect(keychainService("dist")).toBe("com.norma.core");
    expect(keychainService("dev")).toBe("com.norma.core.dev");
  });

  test("profileDisplayName", () => {
    expect(profileDisplayName("dist")).toBe("Norma");
    expect(profileDisplayName("dev")).toBe("Norma Dev");
  });
});
