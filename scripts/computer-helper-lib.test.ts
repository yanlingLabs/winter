import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtHelperPath,
  checkSignedHelper,
  DAEMON_IDENTIFIER,
  HELPER,
  HELPER_EMBED_RELATIVE,
  HELPER_ENTITLEMENT,
  HELPER_ENTITLEMENTS_FILE,
  HELPER_TEST_HOOK_MARKER,
  HELPER_VERSION_MARKER,
  helperBuildArgs,
  helperExecutable,
  helperRequirement,
  helperSignArgs,
  parseHelperVersion,
  pidsRunning,
  readHelperVersion,
  stampHelperInfoPlist,
  stampHelperProjectYml,
  syncHelperVersion,
  type SignedHelperFacts,
} from "./computer-helper-lib";
import { HELPER_PROTOCOL } from "../packages/core/src/computer-use/protocol";

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
    const swift = readFileSync(join(REPO_ROOT, "apple", "ComputerUse", "WinterComputerUse", "Sources", "WinterComputerUseShell", "HelperIdentity.swift"), "utf8");
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
    const main = readFileSync(join(REPO_ROOT, "apple", "ComputerUse", "WinterComputerUse", "App", "main.swift"), "utf8");
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

  test("codesign: the stable identifier, the hardened runtime, the Apple Events entitlement, the stated requirement", () => {
    const args = helperSignArgs({ identityHash: "H", flavor: "dev", teamId: TEAM, appPath: "/a.app" });
    expect(args).toEqual(["--force", "--sign", "H", "--identifier", "com.winter.computeruse.dev", "--options", "runtime", "--timestamp=none",
      "--entitlements", HELPER_ENTITLEMENTS_FILE, `-r=designated => ${helperRequirement("com.winter.computeruse.dev", TEAM)}`, "/a.app"]);
  });

  test("the entitlements file grants exactly the Apple Events entitlement", () => {
    const text = readFileSync(HELPER_ENTITLEMENTS_FILE, "utf8");
    expect([...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual([HELPER_ENTITLEMENT]);
    expect(text).toMatch(/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/);
  });
});

describe("checkSignedHelper", () => {
  const good = (flavor: "dist" | "dev" | "test", over: Partial<SignedHelperFacts> = {}): SignedHelperFacts => ({
    codesignDvv: `Executable=/x\nIdentifier=${HELPER[flavor].identifier}\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+3 location=embedded\nTeamIdentifier=${TEAM}\n`,
    codesignDr: `Executable=/x\ndesignated => ${helperRequirement(HELPER[flavor].identifier, TEAM)}\n`,
    entitlementsXml: `<plist><dict><key>${HELPER_ENTITLEMENT}</key><true/></dict></plist>`,
    infoPlist: { CFBundleIdentifier: HELPER[flavor].identifier, CFBundleName: HELPER[flavor].name, LSUIElement: true, CFBundleShortVersionString: "0.124.0",
      NSAppleEventsUsageDescription: "Winter Computer Use runs AppleScript…" },
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

  test("the Apple Events entitlement and its usage text are required — and nothing beside it", () => {
    expect(checkSignedHelper("dist", TEAM, "0.124.0", good("dist", { entitlementsXml: "" })).join()).toContain(`does not carry ${HELPER_ENTITLEMENT} = true`);
    expect(checkSignedHelper("dist", TEAM, "0.124.0", good("dist", { entitlementsXml: `<dict><key>${HELPER_ENTITLEMENT}</key><false/></dict>` })).join())
      .toContain("does not carry");
    expect(checkSignedHelper("dist", TEAM, "0.124.0", good("dist", {
      entitlementsXml: `<dict><key>${HELPER_ENTITLEMENT}</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict>`,
    })).join()).toContain("beyond com.apple.security.automation.apple-events (com.apple.security.cs.disable-library-validation)");
    const noText = good("dist");
    delete (noText.infoPlist as Record<string, unknown>).NSAppleEventsUsageDescription;
    expect(checkSignedHelper("dist", TEAM, "0.124.0", noText).join()).toContain("NSAppleEventsUsageDescription");
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

// apple/ComputerUse is split-ready: its own protocol spec and its own version.
describe("the helper protocol number is the same everywhere (apple/ComputerUse/PROTOCOL.md)", () => {
  const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");
  const one = (text: string, re: RegExp, where: string): number => {
    const m = re.exec(text);
    if (m === null) throw new Error(`no protocol number found in ${where}`);
    return Number(m[1]);
  };

  test("the spec, the helper, the daemon, WinterKit and the live-test clients all speak one number", () => {
    const spec = one(read("apple", "ComputerUse", "PROTOCOL.md"), /^\*\*Protocol version: (\d+)\*\*$/m, "PROTOCOL.md");
    const helper = one(read("apple", "ComputerUse", "WinterComputerUse", "Sources", "WinterComputerUseShell", "JSONRPC.swift"),
      /public static let protocolVersion = (\d+)/, "RPCWire.protocolVersion");
    const kit = one(read("apple", "WinterKit", "Sources", "WinterKit", "ComputerUseHelperClient.swift"),
      /public static let version = (\d+)/, "ComputerUseHelperProtocol.version");
    const probe = one(read("scripts", "cu-live", "swift", "ViewProbe", "Core.swift"), /static let protocolVersion = (\d+)/, "the view probe");
    expect({ helper, daemon: HELPER_PROTOCOL, kit, probe }).toEqual({ helper: spec, daemon: spec, kit: spec, probe: spec });
  });

  test("no client hard-codes a hello protocol beside its constant", () => {
    for (const file of [["scripts", "verify-computer-helper.ts"], ["scripts", "cu-live", "daemon-entry.ts"], ["packages", "core", "src", "computer-use", "helper-client.ts"]]) {
      expect(read(...file)).not.toMatch(/method: "hello", params: \{ protocol: \d/);
    }
  });
});

describe("the helper's own version (apple/ComputerUse/VERSION)", () => {
  test("is semver, and is what the helper's Info.plist and project.yml lines carry today", () => {
    const v = readHelperVersion();
    expect(parseHelperVersion(`${v}\n`)).toBe(v);
    for (const bad of ["0.124.0.1", "1.0", "01.0.0", "v1.0.0", ""]) expect(() => parseHelperVersion(bad)).toThrow("semver");
    expect(readFileSync(join(REPO_ROOT, "apple", "Winter", "project.yml"), "utf8")).toContain(`CFBundleShortVersionString: "${v}" ${HELPER_VERSION_MARKER}`);
    expect(readFileSync(join(REPO_ROOT, "apple", "ComputerUse", "WinterComputerUse", "Support", "Info.plist"), "utf8"))
      .toMatch(new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${v.replaceAll(".", "\\.")}</string>`));
  });

  test("stamping touches only the marked helper lines, and refuses a project.yml without them", () => {
    const yml = [
      `        CFBundleShortVersionString: "0.124.0"`, `        CFBundleVersion: "0.124.0"`,
      `        CFBundleShortVersionString: "1.0.0" ${HELPER_VERSION_MARKER}`, `        CFBundleVersion: "1.0.0" ${HELPER_VERSION_MARKER}`,
    ].join("\n");
    expect(stampHelperProjectYml(yml, "2.3.4")).toBe(yml.replaceAll(`"1.0.0"`, `"2.3.4"`));
    expect(() => stampHelperProjectYml(`CFBundleShortVersionString: "1.0.0"`, "2.3.4")).toThrow(HELPER_VERSION_MARKER);
    expect(stampHelperInfoPlist("<key>CFBundleShortVersionString</key>\n<string>1.0.0</string><key>CFBundleVersion</key><string>1.0.0</string>", "2.3.4"))
      .toBe("<key>CFBundleShortVersionString</key>\n<string>2.3.4</string><key>CFBundleVersion</key><string>2.3.4</string>");
  });

  test("syncHelperVersion writes only what changes (an in-sync source keeps its mtime)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-version-"));
    try {
      const versionFile = join(dir, "VERSION"), projectYml = join(dir, "project.yml"), infoPlist = join(dir, "Info.plist");
      copyFileSync(join(REPO_ROOT, "apple", "Winter", "project.yml"), projectYml);
      copyFileSync(join(REPO_ROOT, "apple", "ComputerUse", "WinterComputerUse", "Support", "Info.plist"), infoPlist);
      writeFileSync(versionFile, `${readHelperVersion()}\n`);
      expect(syncHelperVersion({ versionFile, projectYml, infoPlist })).toEqual([]);
      writeFileSync(versionFile, "7.8.9\n");
      expect(syncHelperVersion({ versionFile, projectYml, infoPlist })).toEqual([projectYml, infoPlist]);
      expect(readFileSync(projectYml, "utf8")).toContain(`CFBundleShortVersionString: "7.8.9" ${HELPER_VERSION_MARKER}`);
      expect(readFileSync(infoPlist, "utf8")).toContain("<string>7.8.9</string>");
      const mtime = statSync(infoPlist).mtimeMs;
      expect(syncHelperVersion({ versionFile, projectYml, infoPlist })).toEqual([]);
      expect(statSync(infoPlist).mtimeMs).toBe(mtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
