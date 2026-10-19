// N2 S7B part 2: the bundle gate (pure), the manifest the embed phase writes, the dev stage and the verify gate, over stand-in binaries in scratch directories.
// Nothing here runs a launcher or a worker, signs with a real identity, or touches the Keychain, the notary, /Applications or any running Winter.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  COWORK_NATIVE, COWORK_NATIVE_MANIFEST_RELATIVE, checkCoworkNativeBundle, coworkNativeIdentifier, coworkSignArgs, parseCdHash, parseCoworkNativeManifest, readCoworkRepoPins, sha256Hex, type CoworkNativeBundleFacts,
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
    expect(result.lines.filter((l) => l.startsWith("refused:")).length).toBe(7);
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
