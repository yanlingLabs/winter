// N2 S2 — the STANDALONE proof of `embed-cowork-native.sh` (the body of the build phase S7 adds), run the way Xcode runs the CU one:
// BUILT_PRODUCTS_DIR=<mkdtemp>, CONTENTS_FOLDER_PATH=Winter.app/Contents, CONFIGURATION=Release, EXPANDED_CODE_SIGN_IDENTITY=- (ad-hoc:
// this proves the build phase; release.ts, wired by S7, checks the Developer ID team, the timestamp and that the stated requirements
// are satisfied). Every input and output lives in a mkdtemp directory; no real identity, no Keychain, no notarization, no VM.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COWORK_LAUNCHER_PACKAGE, COWORK_NATIVE, COWORK_NATIVE_EMBED_RELATIVE, COWORK_NATIVE_TEAM, COWORK_TEST_BUILD_CONDITION, COWORK_TEST_HOOK_MARKER, COWORK_WORKER_ENTITLEMENT,
  checkSignedNative, coworkRequirement, coworkSignArgs, entitlementKeys, launcherBuildArgs, linkedLibraries, nonPlatformLibraries, type SignedNativeFacts,
} from "./cowork-native-lib";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "embed-cowork-native.sh");
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  temps.push(dir);
  return dir;
};

const ENTITLEMENTS = (keys: string[], value = "true") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${keys.map((k) => `<key>${k}</key><${value}/>`).join("\n")}\n</dict></plist>\n`;

interface Rig { dir: string; launcher: string; worker: string; entitlements: string }
/** Stand-in binaries (a copy of /usr/bin/true each) and the worker's entitlements file, all inside one scratch directory. */
function rig(entitlementKeysInFile: string[] = [COWORK_WORKER_ENTITLEMENT], value = "true"): Rig {
  const dir = scratch("embed-cowork");
  const inputs = join(dir, "in");
  mkdirSync(inputs, { recursive: true });
  const launcher = join(inputs, COWORK_NATIVE.launcher.name);
  const worker = join(inputs, COWORK_NATIVE.worker.name);
  copyFileSync("/usr/bin/true", launcher);
  copyFileSync("/usr/bin/true", worker);
  const entitlements = join(inputs, "worker.entitlements");
  writeFileSync(entitlements, ENTITLEMENTS(entitlementKeysInFile, value));
  return { dir, launcher, worker, entitlements };
}
function embed(r: Rig, over: Record<string, string> = {}, configuration = "Release") {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      CONFIGURATION: configuration,
      BUILT_PRODUCTS_DIR: join(r.dir, "built"),
      CONTENTS_FOLDER_PATH: "Winter.app/Contents",
      EXPANDED_CODE_SIGN_IDENTITY: "-",
      DEVELOPMENT_TEAM: COWORK_NATIVE_TEAM,
      COWORK_LAUNCHER_BINARY: r.launcher,
      COWORK_WORKER_BINARY: r.worker,
      COWORK_WORKER_ENTITLEMENTS: r.entitlements,
      ...over,
    },
  });
}
const dest = (r: Rig) => join(r.dir, "built", "Winter.app", COWORK_NATIVE_EMBED_RELATIVE);

function facts(path: string): SignedNativeFacts {
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });
  return {
    codesignDvv: run("codesign", ["-dvv", path]).stderr,
    codesignDr: (({ stdout, stderr }) => `${stdout}${stderr}`)(run("codesign", ["-d", "-r-", path])),
    entitlementsXml: run("codesign", ["-d", "--entitlements", "-", "--xml", path]).stdout,
    otoolL: run("otool", ["-L", path]).stdout,
    executable: readFileSync(path),
  };
}

describe("embed-cowork-native.sh (the Cowork native pair's build phase, standalone, ad-hoc)", () => {
  test("a non-Release build embeds nothing", () => {
    const r = rig();
    const out = embed(r, {}, "Debug");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("skip Cowork native embed (non-Release)");
    expect(existsSync(dest(r))).toBe(false);
  });

  test("Release: both are signed with their stated requirement, the hardened runtime, and exactly the entitlements they may carry", () => {
    const r = rig();
    const out = embed(r);
    if (out.status !== 0) throw new Error(`exit ${out.status}:\n${out.stderr}\n${out.stdout}`);
    expect(readdirSync(dest(r)).sort()).toEqual([COWORK_NATIVE.launcher.name, COWORK_NATIVE.worker.name]);
    for (const role of ["launcher", "worker"] as const) {
      const path = join(dest(r), COWORK_NATIVE[role].name);
      // Ad-hoc: no team in the signature, so the lib's check runs with no team, and the stated requirement is checked verbatim below.
      expect(checkSignedNative(role, undefined, facts(path))).toEqual([]);
      const dr = spawnSync("codesign", ["-d", "-r-", path], { encoding: "utf8" });
      expect(`${dr.stdout}${dr.stderr}`).toContain(`designated => ${coworkRequirement(COWORK_NATIVE[role].identifier, "37N77U9RSZ")}`);
    }
    expect(entitlementKeys(facts(join(dest(r), COWORK_NATIVE.worker.name)).entitlementsXml)).toEqual(["com.apple.security.hypervisor"]);
    expect(entitlementKeys(facts(join(dest(r), COWORK_NATIVE.launcher.name)).entitlementsXml)).toEqual([]);
    expect(out.stdout).toContain("Cowork native pair embedded at Contents/Helpers/WinterCowork");
  });

  test("the team is a parameter of the stated requirement", () => {
    const r = rig();
    expect(embed(r, { DEVELOPMENT_TEAM: "1ABCDE2345" }).status).toBe(0);
    const dr = spawnSync("codesign", ["-d", "-r-", join(dest(r), COWORK_NATIVE.launcher.name)], { encoding: "utf8" });
    expect(`${dr.stdout}${dr.stderr}`).toContain(`designated => ${coworkRequirement(COWORK_NATIVE.launcher.identifier, "1ABCDE2345")}`);
  });

  test("nested code is signed one at a time, the worker first, and the script never uses --deep", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toContain("--deep");
    expect(code.indexOf('sign_and_check "${WORKER_NAME}"')).toBeGreaterThan(0);
    expect(code.indexOf('sign_and_check "${WORKER_NAME}"')).toBeLessThan(code.indexOf('sign_and_check "${LAUNCHER_NAME}"'));
    // Each member keeps its OWN identifier: a --deep re-sign would have given them one.
    const r = rig();
    expect(embed(r).status).toBe(0);
    expect(signedIdentifier(join(dest(r), COWORK_NATIVE.worker.name))).toBe("com.winter.cowork.worker");
    expect(signedIdentifier(join(dest(r), COWORK_NATIVE.launcher.name))).toBe("com.winter.cowork.launcher");
  });

  test("a re-embed replaces the old copy rather than merging into it", () => {
    const r = rig();
    expect(embed(r).status).toBe(0);
    const stray = join(dest(r), "stale.txt");
    writeFileSync(stray, "left over");
    expect(embed(r).status).toBe(0);
    expect(existsSync(stray)).toBe(false);
  });

  test("refuses a missing input", () => {
    const r = rig();
    rmSync(r.worker);
    const out = embed(r);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(`the built ${COWORK_NATIVE.worker.name} is not at`);
    expect(existsSync(dest(r))).toBe(false);
  });

  test("refuses a binary that contains a test hook, in either member", () => {
    for (const member of ["launcher", "worker"] as const) {
      const r = rig();
      appendFileSync(r[member], `--${COWORK_TEST_HOOK_MARKER}PARENT_CDHASH`);
      const out = embed(r);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain(`${COWORK_NATIVE[member].name} contains test hooks`);
      expect(existsSync(dest(r))).toBe(false);
    }
  });

  test("refuses a binary that names the builder's repository", () => {
    const r = rig();
    appendFileSync(r.launcher, `${REPO}/apple/Cowork/WinterCoworkLauncher/Sources/main.swift`);
    const out = embed(r);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("embeds the builder's repository or home path");
  });

  test("refuses a binary that links a library which is not a platform dylib", () => {
    const clang = spawnSync("xcrun", ["--find", "clang"], { encoding: "utf8" });
    if (clang.status !== 0) return; // no toolchain: the pure check is covered below
    const r = rig();
    const lib = join(r.dir, "libforeign.dylib");
    writeFileSync(join(r.dir, "foreign.c"), "int foreign(void){return 1;}\n");
    writeFileSync(join(r.dir, "main.c"), "int foreign(void);\nint main(void){return foreign()-1;}\n");
    expect(spawnSync("clang", ["-dynamiclib", "-o", lib, join(r.dir, "foreign.c"), "-install_name", lib], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("clang", ["-o", r.launcher, join(r.dir, "main.c"), lib], { encoding: "utf8" }).status).toBe(0);
    const out = embed(r);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(`${COWORK_NATIVE.launcher.name} links non-platform libraries`);
  });

  test("refuses a worker entitlements file that is not exactly the hypervisor key set to true", () => {
    for (const keys of [[COWORK_WORKER_ENTITLEMENT, "com.apple.security.cs.allow-jit"], [COWORK_WORKER_ENTITLEMENT, "com.apple.security.cs.disable-library-validation"],
      [COWORK_WORKER_ENTITLEMENT, "com.apple.security.get-task-allow"], ["com.apple.vm.networking"], []]) {
      const r = rig(keys);
      const out = embed(r);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("must contain exactly com.apple.security.hypervisor");
      expect(existsSync(dest(r))).toBe(false);
    }
    const off = rig([COWORK_WORKER_ENTITLEMENT], "false");
    const out = embed(off);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("must be set to true");
  });
});

function signedIdentifier(path: string): string | undefined {
  return /^Identifier=(.+)$/m.exec(spawnSync("codesign", ["-dvv", path], { encoding: "utf8" }).stderr)?.[1];
}

describe("cowork-native-lib", () => {
  const good = (role: "launcher" | "worker"): SignedNativeFacts => ({
    codesignDvv: `Identifier=${COWORK_NATIVE[role].identifier}\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+2 location=embedded\nTeamIdentifier=${COWORK_NATIVE_TEAM}\n`,
    codesignDr: `designated => ${coworkRequirement(COWORK_NATIVE[role].identifier)}\n`,
    entitlementsXml: role === "worker" ? ENTITLEMENTS([COWORK_WORKER_ENTITLEMENT]) : "",
    otoolL: "/x/bin:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/IOKit.framework/Versions/A/IOKit (compatibility version 1.0.0)\n\t/usr/lib/swift/libswiftCore.dylib (compatibility version 1.0.0)\n",
    executable: Buffer.from("MACHO"),
  });

  test("the requirement is the stated shape for both members", () => {
    expect(coworkRequirement(COWORK_NATIVE.launcher.identifier)).toBe('identifier "com.winter.cowork.launcher" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"');
    expect(coworkRequirement(COWORK_NATIVE.worker.identifier)).toBe('identifier "com.winter.cowork.worker" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"');
  });
  test("a correct signature of each member has no failures", () => {
    expect(checkSignedNative("launcher", COWORK_NATIVE_TEAM, good("launcher"))).toEqual([]);
    expect(checkSignedNative("worker", COWORK_NATIVE_TEAM, good("worker"))).toEqual([]);
  });
  test("every way a member can be wrong is named", () => {
    const bad = (role: "launcher" | "worker", over: Partial<SignedNativeFacts>) => checkSignedNative(role, COWORK_NATIVE_TEAM, { ...good(role), ...over });
    expect(bad("launcher", { codesignDvv: good("launcher").codesignDvv.replace("com.winter.cowork.launcher", "winter-cowork-launcher") }).join("|")).toContain("codesign identifier is winter-cowork-launcher");
    expect(bad("launcher", { codesignDvv: good("launcher").codesignDvv.replace("flags=0x10000(runtime)", "flags=0x2(adhoc)") }).join("|")).toContain("hardened runtime");
    expect(bad("launcher", { codesignDvv: good("launcher").codesignDvv.replace(COWORK_NATIVE_TEAM, "ZZZZZZZZZZ") }).join("|")).toContain("TeamIdentifier is ZZZZZZZZZZ");
    expect(bad("launcher", { codesignDr: "designated => anchor apple\n" }).join("|")).toContain("designated requirement");
    expect(bad("launcher", { entitlementsXml: ENTITLEMENTS([COWORK_WORKER_ENTITLEMENT]) }).join("|")).toContain("entitlements are [com.apple.security.hypervisor], expected exactly []");
    expect(bad("worker", { entitlementsXml: "" }).join("|")).toContain("expected exactly [com.apple.security.hypervisor]");
    expect(bad("worker", { entitlementsXml: ENTITLEMENTS([COWORK_WORKER_ENTITLEMENT, "com.apple.security.cs.allow-jit"]) }).join("|")).toContain("allow-jit");
    expect(bad("worker", { entitlementsXml: ENTITLEMENTS([COWORK_WORKER_ENTITLEMENT], "false") }).join("|")).toContain("not set to true");
    expect(bad("launcher", { otoolL: `${good("launcher").otoolL}\t/opt/homebrew/lib/libkrun.dylib (compatibility version 1.0.0)\n` }).join("|")).toContain("/opt/homebrew/lib/libkrun.dylib");
    expect(bad("launcher", { otoolL: `${good("launcher").otoolL}\t@rpath/libfoo.dylib (compatibility version 1.0.0)\n` }).join("|")).toContain("@rpath/libfoo.dylib");
    expect(bad("launcher", { executable: Buffer.from(`xx--${COWORK_TEST_HOOK_MARKER}PARENT_CDHASH`) }).join("|")).toContain("contains test hooks");
  });
  test("an ad-hoc test signature is checked without a team", () => {
    const adhoc = { ...good("launcher"), codesignDvv: "Identifier=com.winter.cowork.launcher\nCodeDirectory v=20500 flags=0x10002(adhoc,runtime) hashes=1+2\nTeamIdentifier=not set\n" };
    expect(checkSignedNative("launcher", undefined, adhoc)).toEqual([]);
    expect(checkSignedNative("launcher", COWORK_NATIVE_TEAM, adhoc).join("|")).toContain("TeamIdentifier is not set");
  });
  test("library parsing keeps platform paths and refuses the rest", () => {
    const out = "/b:\n\t/usr/lib/swift/libswiftCore.dylib (compatibility version 1.0.0, current version 1.0.0, weak)\n\t/usr/local/lib/libx.dylib (compatibility version 1.0.0)\n";
    expect(linkedLibraries(out)).toEqual(["/usr/lib/swift/libswiftCore.dylib", "/usr/local/lib/libx.dylib"]);
    expect(nonPlatformLibraries(linkedLibraries(out))).toEqual(["/usr/local/lib/libx.dylib"]);
    expect(nonPlatformLibraries(["/usr/libevil/x.dylib", "/System/Library/Frameworks/A"])).toEqual(["/usr/libevil/x.dylib"]);
  });
  test("the build and sign commands have the shapes the script and the package use", () => {
    expect(launcherBuildArgs({ packagePath: "/p", scratchPath: "/s" })).toEqual(["build", "--package-path", "/p", "--scratch-path", "/s", "-c", "release", "--product", "winter-cowork-launcher",
      "-Xswiftc", "-gnone", "-Xlinker", "-S", "-Xlinker", "-x"]);
    expect(launcherBuildArgs({ packagePath: "/p", scratchPath: "/s", testBuild: true }).slice(-2)).toEqual(["-Xswiftc", `-D${COWORK_TEST_BUILD_CONDITION}`]);
    expect(coworkSignArgs({ identity: "HASH", role: "worker", path: "/w", entitlementsFile: "/e" })).toEqual([
      "--force", "--sign", "HASH", "--identifier", "com.winter.cowork.worker", "--options", "runtime", "--timestamp", "--entitlements", "/e",
      `-r=designated => ${coworkRequirement("com.winter.cowork.worker")}`, "/w"]);
    expect(coworkSignArgs({ identity: "HASH", role: "launcher", path: "/l", timestamp: false })).not.toContain("--entitlements");
    expect(COWORK_LAUNCHER_PACKAGE).toBe("apple/Cowork/WinterCoworkLauncher");
  });
});

describe("the pair stays unwired and agrees with the Swift launcher", () => {
  const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

  test("the script's identifiers, team and flag are the lib's and the Swift launcher's", () => {
    const script = read("scripts", "embed-cowork-native.sh");
    const swift = read("apple", "Cowork", "WinterCoworkLauncher", "Sources", "LauncherCore", "Identity", "CodeIdentity.swift");
    for (const role of ["launcher", "worker"] as const) {
      expect(script).toContain(`"${COWORK_NATIVE[role].identifier}"`);
      expect(script).toContain(`"${COWORK_NATIVE[role].name}"`);
      expect(swift).toContain(`"${COWORK_NATIVE[role].identifier}"`);
    }
    expect(script).toContain(COWORK_NATIVE_TEAM);
    expect(swift).toContain(COWORK_NATIVE_TEAM);
    expect(script).toContain(`"${COWORK_TEST_HOOK_MARKER}"`);
    expect(script).toContain(COWORK_WORKER_ENTITLEMENT);
    expect(read("apple", "Cowork", "WinterCoworkLauncher", "Sources", "LauncherCore", "Launcher", "LauncherArguments.swift")).toContain(COWORK_TEST_BUILD_CONDITION);
    // The Swift launcher states the same requirement shape this lib and the script state.
    expect(swift).toContain('"identifier \\"\\(identifier)\\" and anchor apple generic and certificate leaf[subject.OU] = \\"\\(team)\\""');
  });

  test("the script is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  test("nothing in the app project, the release gate or the daemon/CLI sources refers to the launcher, the pair or this script (S7 wires them)", () => {
    const needles = ["embed-cowork-native", "cowork-native-lib", "winter-cowork-launcher", "winter-cowork-worker", "WinterCoworkLauncher"];
    const files = [
      join("apple", "Winter", "project.yml"), join("scripts", "release.ts"), join("scripts", "release-lib.ts"), join("package.json"),
      ...walk(join(REPO, "packages", "core", "src")).map((p) => p.slice(REPO.length + 1)),
      ...walk(join(REPO, "packages", "cli", "src")).map((p) => p.slice(REPO.length + 1)),
    ];
    const hits = files.filter((file) => existsSync(join(REPO, file)) && needles.some((needle) => read(file).includes(needle)));
    expect(hits).toEqual([]);
  });
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
}
