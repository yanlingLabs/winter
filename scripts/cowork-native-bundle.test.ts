// N2 S7B part 2: the bundle gate (pure), the manifest the embed phase writes, the dev stage and the verify gate, over stand-in binaries in scratch directories.
// Nothing here runs a launcher or a worker, signs with a real identity, or touches the Keychain, the notary, /Applications or any running Winter.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  COWORK_NATIVE, checkCoworkNativeOmitted, coworkNativeReleasePlan, COWORK_NATIVE_MANIFEST_RELATIVE, checkCoworkNativeBundle, coworkNativeIdentifier, coworkSignArgs, parseCdHash, parseCoworkNativeManifest, readCoworkRepoPins, sha256Hex, type CoworkNativeBundleFacts,
} from "./cowork-native-lib";
import { workerBuildArgs } from "./build-cowork-native";
import { stageDevPair } from "./dev-cowork-native";
import { verifyCoworkNative } from "./verify-cowork-native";

const REPO = join(import.meta.dir, "..");
const temps: string[] = [];
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "cowork-bundle-")); temps.push(d); return d; };
const standIns = (): { launcher: string; worker: string } => {
  const d = scratch();
  const launcher = join(d, COWORK_NATIVE.launcher.name), worker = join(d, COWORK_NATIVE.worker.name);
  copyFileSync("/usr/bin/true", launcher); copyFileSync("/usr/bin/true", worker);
  return { launcher, worker };
};

const pins = () => readCoworkRepoPins(REPO);
const CD_L = "a".repeat(40), CD_W = "b".repeat(40);
function goodFacts(): CoworkNativeBundleFacts {
  const manifest = { formatVersion: 1, launcher: { identifier: COWORK_NATIVE.launcher.identifier, cdhash: CD_L }, worker: { identifier: COWORK_NATIVE.worker.identifier, cdhash: CD_W }, pins: pins() };
  return { entries: [COWORK_NATIVE.launcher.name, COWORK_NATIVE.worker.name], manifestText: JSON.stringify(manifest), liveCdhash: { launcher: CD_L, worker: CD_W }, repoPins: pins() };
}
const withManifest = (change: (m: any) => void): CoworkNativeBundleFacts => { const f = goodFacts(), m = JSON.parse(f.manifestText!); change(m); return { ...f, manifestText: JSON.stringify(m) }; };

describe("checkCoworkNativeBundle", () => {
  test("accepts exactly the pair, a matching manifest, matching CDHashes and the repository's pins", () => {
    expect(checkCoworkNativeBundle(goodFacts())).toEqual([]);
  });
  test("refuses each way the bundle can disagree with itself or with the checkout", () => {
    const cases: [string, CoworkNativeBundleFacts, RegExp][] = [
      ["extra entry", { ...goodFacts(), entries: [...goodFacts().entries, "extra"] }, /holds \[extra/],
      ["missing worker", { ...goodFacts(), entries: [COWORK_NATIVE.launcher.name] }, /holds \[winter-cowork-launcher\]/],
      ["no manifest", { ...goodFacts(), manifestText: null }, /manifest cowork-native-pins.json is missing/],
      ["garbage manifest", { ...goodFacts(), manifestText: "nope" }, /not JSON/],
      ["extra manifest key", withManifest((m) => { m.extra = 1; }), /exactly the expected shape/],
      ["short cdhash", withManifest((m) => { m.worker.cdhash = "ab"; }), /exactly the expected shape/],
      ["wrong identifier", withManifest((m) => { m.launcher.identifier = "com.example.x"; }), /names identifier com.example.x/],
      ["launcher cdhash differs", { ...goodFacts(), liveCdhash: { launcher: "c".repeat(40), worker: CD_W } }, /launcher.*CDHash/],
      ["worker cdhash unreadable", { ...goodFacts(), liveCdhash: { launcher: CD_L, worker: undefined } }, /no CDHash could be read/],
      ["libkrun archive pin differs", withManifest((m) => { m.pins.libkrunArchiveSha256 = "0".repeat(64); }), /pin libkrunArchiveSha256/],
      ["libkrun header pin differs", withManifest((m) => { m.pins.libkrunHeaderSha256 = "0".repeat(64); }), /pin libkrunHeaderSha256/],
      ["worker pins file differs", withManifest((m) => { m.pins.workerPinsSha256 = "0".repeat(64); }), /pin workerPinsSha256/],
      ["guest image pins differ", withManifest((m) => { m.pins.guestArtifactPinsSha256 = "0".repeat(64); }), /pin guestArtifactPinsSha256/],
    ];
    for (const [name, facts, expected] of cases) {
      const failures = checkCoworkNativeBundle(facts);
      expect(`${name}: ${failures.join(" | ")}`).toMatch(new RegExp(`^${name}: .*${expected.source}`));
    }
  });
  test("the repository pins are read from the real pin files", () => {
    const real = pins();
    expect(real.libkrunArchiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(real.workerPinsSha256).toBe(sha256Hex(readFileSync(join(REPO, "apple/Cowork/WinterCoworkHVFWorker/pins.json"))));
    expect(real.guestArtifactPinsSha256).toBe(sha256Hex(readFileSync(join(REPO, "scripts/cowork-guest-artifact/pins.json"))));
  });
  test("parseCdHash needs the CDHash= line of -dvvv; -dvv has none", () => {
    expect(parseCdHash(`Identifier=x\nCDHash=${CD_L}\n`)).toBe(CD_L);
    expect(parseCdHash("Identifier=x\nCodeDirectory v=20500\n")).toBeUndefined();
    const problems: string[] = [];
    expect(parseCoworkNativeManifest("[]", problems)).toBeNull();
    expect(problems.length).toBe(1);
  });
});

describe("flavors", () => {
  test("the dev launcher is signed as its dev identifier, the worker is the same in both flavors", () => {
    expect(coworkNativeIdentifier("launcher", "dev")).toBe("com.winter.cowork.launcher.dev");
    expect(coworkNativeIdentifier("launcher")).toBe("com.winter.cowork.launcher");
    expect(coworkNativeIdentifier("worker", "dev")).toBe("com.winter.cowork.worker");
    expect(coworkSignArgs({ identity: "-", role: "launcher", flavor: "dev", path: "/x", timestamp: false })).toContain("com.winter.cowork.launcher.dev");
  });
});

describe("the embed phase writes the manifest the gate reads", () => {
  test("a Release embed over stand-ins yields a bundle the gate accepts, with the manifest at the stated place", () => {
    const result = verifyCoworkNative(standIns());
    expect(result.failures).toEqual([]);
    expect(result.lines.filter((l) => l.startsWith("refused:")).length).toBe(10); // seven bundle mutants, three omit/input refusals
    expect(result.lines.some((l) => l.startsWith("omit: the stale pair"))).toBe(true);
    expect(result.lines.some((l) => l.startsWith("no inputs: the build succeeded"))).toBe(true);
    expect(COWORK_NATIVE_MANIFEST_RELATIVE).toBe("Contents/Resources/cowork-native-pins.json");
  });
});

describe("dev:cowork-native stages and signs into a directory it is given", () => {
  test("ad hoc into a scratch directory: both members, dev launcher identity, nothing else; a failing sign leaves the target untouched", () => {
    const inputs = standIns(), target = join(scratch(), "Helpers", "WinterCowork");
    expect(stageDevPair({ ...inputs, target, identity: "-", teamId: undefined })).toEqual([]);
    expect(readdirSync(target).sort()).toEqual([COWORK_NATIVE.launcher.name, COWORK_NATIVE.worker.name]);
    const id = spawnSync("codesign", ["-dvv", join(target, COWORK_NATIVE.launcher.name)], { encoding: "utf8" }).stderr;
    expect(id).toContain("Identifier=com.winter.cowork.launcher.dev");
    const before = readFileSync(join(target, COWORK_NATIVE.worker.name));
    const failures = stageDevPair({ ...inputs, target, identity: "no-such-identity", teamId: undefined });
    expect(failures.length).toBeGreaterThan(0);
    expect(readFileSync(join(target, COWORK_NATIVE.worker.name)).equals(before)).toBe(true);
    expect(readdirSync(join(target, "..")).filter((n) => n.startsWith(".WinterCowork-"))).toEqual([]);
  });
  test("the ad-hoc default refuses to write the dev daemon's own directory (the script's rule, pinned in its source)", () => {
    expect(readFileSync(join(REPO, "scripts", "dev-cowork-native.ts"), "utf8")).toContain("--identity - (ad hoc) needs --out <scratch dir>");
  });
});

describe("the build script", () => {
  test("the worker is built by build.py with an out directory and both libkrun inputs; nothing is downloaded", () => {
    const args = workerBuildArgs({ out: "/o", include: "/i", archive: "/a" });
    expect(args.slice(0, 1)).toEqual(["-I"]);
    expect(args).toContain("worker");
    expect(args.slice(-6)).toEqual(["--out", "/o", "--libkrun-include", "/i", "--libkrun-archive", "/a"]);
  });
  test("package.json names the dev and verify entry points", () => {
    const scripts = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts;
    expect(scripts["dev:cowork-native"]).toBe("bun run scripts/dev-cowork-native.ts");
    expect(scripts["verify:cowork-native"]).toBe("bun run scripts/verify-cowork-native.ts");
  });
});

describe("the release choice: inputs or an explicit omit", () => {
  const INC = "/libkrun/include", ARC = "/libkrun/libkrun.a";
  test("every branch of coworkNativeReleasePlan", () => {
    const plan = coworkNativeReleasePlan;
    expect(plan({ COWORK_LIBKRUN_INCLUDE: INC, COWORK_LIBKRUN_ARCHIVE: ARC })).toEqual({ mode: "build", include: INC, archive: ARC });
    expect(plan({ COWORK_NATIVE: "omit" })).toEqual({ mode: "omit" });
    expect(plan({ COWORK_NATIVE: " omit " })).toEqual({ mode: "omit" });
    const refusals: [string, Record<string, string>, RegExp][] = [
      ["neither", {}, /neither its inputs nor an explicit omit.*COWORK_NATIVE=omit/],
      ["empty strings", { COWORK_LIBKRUN_INCLUDE: "", COWORK_LIBKRUN_ARCHIVE: "  ", COWORK_NATIVE: "" }, /neither its inputs nor an explicit omit/],
      ["include alone", { COWORK_LIBKRUN_INCLUDE: INC }, /only one of/],
      ["archive alone", { COWORK_LIBKRUN_ARCHIVE: ARC }, /only one of/],
      ["omit and inputs", { COWORK_NATIVE: "omit", COWORK_LIBKRUN_INCLUDE: INC, COWORK_LIBKRUN_ARCHIVE: ARC }, /contradicts/],
      ["omit and one input", { COWORK_NATIVE: "omit", COWORK_LIBKRUN_ARCHIVE: ARC }, /contradicts/],
      ["a typo", { COWORK_NATIVE: "skip" }, /not a choice/],
      ["a typo beside the inputs", { COWORK_NATIVE: "build", COWORK_LIBKRUN_INCLUDE: INC, COWORK_LIBKRUN_ARCHIVE: ARC }, /not a choice/],
    ];
    for (const [name, env, expected] of refusals) {
      const result = plan(env);
      expect(`${name}: ${result.mode}: ${result.mode === "refuse" ? result.message : ""}`).toMatch(new RegExp(`^${name}: refuse: .*${expected.source}`));
    }
  });
  test("the omit gate: no helpers directory and no pins file, nothing else is accepted", () => {
    expect(checkCoworkNativeOmitted({ helpersDirectoryExists: false, manifestText: null })).toEqual([]);
    expect(checkCoworkNativeOmitted({ helpersDirectoryExists: true, manifestText: null }).join()).toContain("Helpers/WinterCowork exists");
    expect(checkCoworkNativeOmitted({ helpersDirectoryExists: false, manifestText: "{}" }).join()).toContain("cowork-native-pins.json exists");
    expect(checkCoworkNativeOmitted({ helpersDirectoryExists: true, manifestText: "{}" }).length).toBe(2);
  });
  describe("the embed phase under each choice (ad hoc, scratch)", () => {
    const run = (env: Record<string, string>, built: string, inputs = standIns()) => spawnSync("bash", [join(REPO, "scripts", "embed-cowork-native.sh")], {
      encoding: "utf8", timeout: 120_000,
      env: { ...process.env, CONFIGURATION: "Release", BUILT_PRODUCTS_DIR: built, CONTENTS_FOLDER_PATH: "Winter.app/Contents", EXPANDED_CODE_SIGN_IDENTITY: "-", DEVELOPMENT_TEAM: "37N77U9RSZ",
        COWORK_LAUNCHER_BINARY: inputs.launcher, COWORK_WORKER_BINARY: inputs.worker, ...env },
    });
    const contents = (built: string) => join(built, "Winter.app", "Contents");
    test("omit removes a stale pair and pins file and succeeds; with nothing stale it is a no-op", () => {
      const built = scratch();
      expect(run({}, built).status).toBe(0);
      expect(existsSync(join(contents(built), "Helpers", "WinterCowork"))).toBe(true);
      const omitted = run({ COWORK_NATIVE: "omit" }, built);
      expect(omitted.status).toBe(0);
      expect(omitted.stdout).toContain("COWORK_NATIVE=omit");
      expect(existsSync(join(contents(built), "Helpers", "WinterCowork"))).toBe(false);
      expect(existsSync(join(contents(built), "Resources", "cowork-native-pins.json"))).toBe(false);
      expect(run({ COWORK_NATIVE: "omit" }, scratch()).status).toBe(0);
    });
    test("omit wins even when valid inputs are present (the plan refuses the combination before the build; here nothing is embedded)", () => {
      const built = scratch();
      expect(run({ COWORK_NATIVE: "omit" }, built).status).toBe(0);
      expect(existsSync(join(contents(built), "Helpers"))).toBe(false);
    });
    test("an unknown COWORK_NATIVE value fails and embeds nothing", () => {
      const built = scratch();
      const result = run({ COWORK_NATIVE: "skip" }, built);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("is not a choice");
      expect(existsSync(contents(built))).toBe(false);
    });
    test("no input at all (a developer's Release build, CI): succeeds, embeds nothing, removes a stale pair", () => {
      const built = scratch();
      expect(run({}, built).status).toBe(0);
      const none = run({ COWORK_LAUNCHER_BINARY: join(built, "absent-l"), COWORK_WORKER_BINARY: join(built, "absent-w") }, built);
      expect(none.status).toBe(0);
      expect(none.stdout).toContain("no inputs");
      expect(existsSync(join(contents(built), "Helpers", "WinterCowork"))).toBe(false);
      expect(existsSync(join(contents(built), "Resources", "cowork-native-pins.json"))).toBe(false);
    });
    test("exactly one input is an error, whichever it is", () => {
      for (const missing of ["COWORK_LAUNCHER_BINARY", "COWORK_WORKER_BINARY"]) {
        const built = scratch();
        const result = run({ [missing]: join(built, "absent") }, built);
        expect(`${missing}: ${result.status !== 0}`).toBe(`${missing}: true`);
        expect(result.stderr).toContain("is not at");
      }
    });
    test("a Debug build embeds nothing whatever the inputs", () => {
      const built = scratch();
      const result = run({ CONFIGURATION: "Debug" }, built);
      expect(result.status).toBe(0);
      expect(existsSync(contents(built))).toBe(false);
    });
  });
  test("an omitted bundle gives the daemon nothing to spawn: the default launcher port refuses launcher_missing before spawning anything (core test)", () => {
    expect(readFileSync(join(REPO, "packages", "core", "test", "cowork", "host-env-assembly.test.ts"), "utf8")).toContain("an omitted bundle");
  });
});
