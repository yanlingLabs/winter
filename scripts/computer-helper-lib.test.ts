import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  builtHelperPath,
  checkSignedHelper,
  DAEMON_IDENTIFIER,
  HELPER,
  HELPER_EMBED_RELATIVE,
  HELPER_TEST_HOOK_MARKER,
  helperBuildArgs,
  helperExecutable,
  helperRequirement,
  helperSignArgs,
  pidsRunning,
  type SignedHelperFacts,
} from "./computer-helper-lib";

const TEAM = "37N77U9RSZ";
const REPO_ROOT = join(import.meta.dir, "..");

describe("the helper's identities", () => {
  test("bundle ids, names and the embedded location are the pinned ones", () => {
    expect(HELPER.dist).toEqual({ identifier: "com.winter.computeruse", name: "Winter Computer Use" });
    expect(HELPER.dev).toEqual({ identifier: "com.winter.computeruse.dev", name: "Winter Computer Use Dev" });
    expect(HELPER_EMBED_RELATIVE).toBe("Contents/Helpers/Winter Computer Use.app");
    expect(helperExecutable("/x/Winter Computer Use Dev.app", "dev")).toBe("/x/Winter Computer Use Dev.app/Contents/MacOS/Winter Computer Use Dev");
  });

  test("the stated requirement: identifier + Winter's team under Apple's anchor (the dev daemon's shape)", () => {
    expect(helperRequirement("com.winter.computeruse", TEAM)).toBe(`identifier "com.winter.computeruse" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`);
  });

  test("the Swift shell names the same identities (one source of truth per language, held together here)", () => {
    const swift = readFileSync(join(REPO_ROOT, "apple", "WinterComputerUse", "Sources", "WinterComputerUseShell", "HelperIdentity.swift"), "utf8");
    for (const flavor of ["dist", "dev", "test"] as const) expect(swift).toContain(`"${HELPER[flavor].identifier}"`);
    expect(swift).toContain(`distDaemonIdentifier = "${DAEMON_IDENTIFIER.dist}"`);
    expect(swift).toContain(`devDaemonIdentifier = "${DAEMON_IDENTIFIER.dev}"`);
    expect(swift).toContain(`teamID = "${TEAM}"`);
    const yml = readFileSync(join(REPO_ROOT, "apple", "Winter", "project.yml"), "utf8");
    expect(yml).toContain(`PRODUCT_BUNDLE_IDENTIFIER: ${HELPER.dist.identifier}\n`);
    // The dev id comes only from dev:helper's command line; an Xcode Debug build gets a placeholder that
    // LaunchServices can never hand out for com.winter.computeruse.dev (and that the helper refuses to run as).
    expect(yml).toContain("PRODUCT_BUNDLE_IDENTIFIER: com.winter.computeruse.xcode-debug\n");
    expect(yml).not.toContain(`PRODUCT_BUNDLE_IDENTIFIER: ${HELPER.dev.identifier}\n`);
    expect(yml).toContain(`WINTER_CU_APP_NAME: ${HELPER.dist.name}\n`);
    expect(yml).toContain(`WINTER_CU_APP_NAME: ${HELPER.dev.name}\n`);
  });

  test("the test hooks exist only under the test-build condition, in main.swift alone", () => {
    const main = readFileSync(join(REPO_ROOT, "apple", "WinterComputerUse", "App", "main.swift"), "utf8");
    const hooked = main.slice(main.indexOf("#if WINTER_CU_TEST_BUILD"), main.indexOf("#else"));
    expect(hooked).toContain(`${HELPER_TEST_HOOK_MARKER}DAEMON_REQUIREMENT`);
    expect(main.replace(hooked, "")).not.toContain(HELPER_TEST_HOOK_MARKER);
    const yml = readFileSync(join(REPO_ROOT, "apple", "Winter", "project.yml"), "utf8");
    expect(yml).not.toContain("WINTER_CU_TEST_BUILD");
  });
});

describe("building and signing", () => {
  test("dev: the helper scheme, Debug, unsigned; test: plus its own id, name and the test-build condition", () => {
    const dev = helperBuildArgs({ flavor: "dev", derivedDataPath: "/dd" });
    expect(dev).toEqual(["-project", "Winter.xcodeproj", "-scheme", "WinterComputerUse", "-configuration", "Debug", "-destination", "platform=macOS", "-derivedDataPath", "/dd", "CODE_SIGNING_ALLOWED=NO", "PRODUCT_BUNDLE_IDENTIFIER=com.winter.computeruse.dev", "build"]);
    const test = helperBuildArgs({ flavor: "test", derivedDataPath: "/dd" });
    expect(test).toContain("PRODUCT_BUNDLE_IDENTIFIER=com.winter.computeruse.test");
    expect(test).toContain("WINTER_CU_APP_NAME=Winter Computer Use Test");
    expect(test).toContain("SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG WINTER_CU_TEST_BUILD");
    expect(builtHelperPath("/dd", "test")).toBe("/dd/Build/Products/Debug/Winter Computer Use Test.app");
  });

  test("codesign: the stable identifier, the hardened runtime, the stated requirement, no entitlements flag", () => {
    const args = helperSignArgs({ identityHash: "H", flavor: "dev", teamId: TEAM, appPath: "/a.app" });
    expect(args).toEqual(["--force", "--sign", "H", "--identifier", "com.winter.computeruse.dev", "--options", "runtime", "--timestamp=none",
      `-r=designated => ${helperRequirement("com.winter.computeruse.dev", TEAM)}`, "/a.app"]);
    expect(args.join(" ")).not.toContain("--entitlements");
  });
});

describe("checkSignedHelper", () => {
  const good = (flavor: "dist" | "dev" | "test", over: Partial<SignedHelperFacts> = {}): SignedHelperFacts => ({
    codesignDvv: `Executable=/x\nIdentifier=${HELPER[flavor].identifier}\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+3 location=embedded\nTeamIdentifier=${TEAM}\n`,
    codesignDr: `Executable=/x\ndesignated => ${helperRequirement(HELPER[flavor].identifier, TEAM)}\n`,
    entitlementsXml: "",
    infoPlist: { CFBundleIdentifier: HELPER[flavor].identifier, CFBundleName: HELPER[flavor].name, LSUIElement: true, CFBundleShortVersionString: "0.124.0" },
    executable: new TextEncoder().encode(flavor === "test" ? `...${HELPER_TEST_HOOK_MARKER}DAEMON_REQUIREMENT...` : "...nothing..."),
    ...over,
  });

  test("a correctly signed bundle passes, for every flavor", () => {
    for (const flavor of ["dist", "dev", "test"] as const) expect(checkSignedHelper(flavor, TEAM, "0.124.0", good(flavor))).toEqual([]);
  });

  test("a derived requirement (naming the certificate) fails — TCC would lose the grants at the next signer", () => {
    const f = checkSignedHelper("dist", TEAM, "0.124.0", good("dist", {
      codesignDr: `designated => identifier "com.winter.computeruse" and anchor apple generic and certificate leaf[subject.CN] = "Developer ID Application: Someone (${TEAM})"\n`,
    }));
    expect(f.join()).toContain("designated requirement is");
  });

  test("the wrong team, identifier, no hardened runtime, any entitlement, a wrong plist or version all fail", () => {
    const failures = checkSignedHelper("dist", TEAM, "0.124.1", good("dist", {
      codesignDvv: "Identifier=Winter Computer Use\nCodeDirectory v=1 size=1 flags=0x2(adhoc) hashes=1\nTeamIdentifier=not set\n",
      entitlementsXml: "<plist><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>",
      infoPlist: { CFBundleIdentifier: "com.winter.computeruse.dev", CFBundleName: "Winter Computer Use", LSUIElement: false, CFBundleShortVersionString: "0.124.0" },
    })).join("\n");
    for (const needle of ["codesign identifier", "TeamIdentifier", "hardened runtime", "get-task-allow", "CFBundleIdentifier", "LSUIElement", "CFBundleShortVersionString"]) {
      expect(failures).toContain(needle);
    }
  });

  test("test hooks: required in the test flavor, refused in dev and dist", () => {
    expect(checkSignedHelper("dist", TEAM, "0.124.0", good("dist", { executable: new TextEncoder().encode(`${HELPER_TEST_HOOK_MARKER}IDLE_SECONDS`) })).join()).toContain("contains test hooks");
    expect(checkSignedHelper("dev", TEAM, "0.124.0", good("dev", { executable: new TextEncoder().encode(`${HELPER_TEST_HOOK_MARKER}IDLE_SECONDS`) })).join()).toContain("contains test hooks");
    expect(checkSignedHelper("test", TEAM, "0.124.0", good("test", { executable: new TextEncoder().encode("clean") })).join()).toContain("no test hooks compiled in");
  });
});

test("pidsRunning: matches the exact executable, never a prefix of another path", () => {
  const exe = "/r/dist/dev/Winter Computer Use Dev.app/Contents/MacOS/Winter Computer Use Dev";
  const ps = ` 101 ${exe}\n 102 ${exe} -psn_0_1\n 103 ${exe}2\n 104 /bin/zsh\n`;
  expect(pidsRunning(ps, exe)).toEqual([101, 102]);
});
