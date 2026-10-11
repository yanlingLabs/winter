// ComputerV2 — the STANDALONE proof of `embed-computer-helper.sh` (the body of project.yml's "Embed Winter
// Computer Use" postCompileScript), run the way Xcode runs it: BUILT_PRODUCTS_DIR=<mkdtemp>,
// CONTENTS_FOLDER_PATH=Winter.app/Contents, CONFIGURATION=Release, EXPANDED_CODE_SIGN_IDENTITY=- (ad-hoc: this
// proves the build phase; release.ts checks the Developer ID team, the timestamp and that the stated
// requirement is satisfied on the real artifact).
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_HOST, BROWSER_HOST_EXECUTABLE, HELPER, HELPER_EMBED_RELATIVE, helperRequirement, readHelperVersion } from "./computer-helper-lib";

const SCRIPT = join(import.meta.dir, "embed-computer-helper.sh");
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A built-products dir holding a minimal "Winter Computer Use.app" with `bundleId` at `version` (default: the
 *  helper's own, apple/ComputerUse/VERSION). */
function builtProducts(bundleId: string, version: string = readHelperVersion(), withHost = true): string {
  const dir = mkdtempSync(join(tmpdir(), "embed-cu-"));
  temps.push(dir);
  const app = join(dir, `${HELPER.dist.name}.app`, "Contents");
  mkdirSync(join(app, "MacOS"), { recursive: true });
  copyFileSync("/usr/bin/true", join(app, "MacOS", HELPER.dist.name));
  if (withHost) copyFileSync("/usr/bin/true", join(app, "MacOS", BROWSER_HOST_EXECUTABLE));
  writeFileSync(
    join(app, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${HELPER.dist.name}</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
  );
  return dir;
}

function embed(dir: string, configuration = "Release") {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      CONFIGURATION: configuration,
      BUILT_PRODUCTS_DIR: dir,
      CONTENTS_FOLDER_PATH: "Winter.app/Contents",
      EXPANDED_CODE_SIGN_IDENTITY: "-",
      DEVELOPMENT_TEAM: "37N77U9RSZ",
    },
  });
}

describe("embed-computer-helper.sh (the 'Embed Winter Computer Use' postCompileScript, standalone)", () => {
  test("a non-Release build embeds nothing", () => {
    const dir = builtProducts(HELPER.dist.identifier);
    const r = embed(dir, "Debug");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skip Winter Computer Use embed (non-Release)");
    expect(existsSync(join(dir, "Winter.app", HELPER_EMBED_RELATIVE))).toBe(false);
  });

  test("Release: copies the helper into Contents/Helpers and signs it with the stated requirement, the hardened runtime and the Apple Events entitlement only", () => {
    const dir = builtProducts(HELPER.dist.identifier);
    const r = embed(dir);
    if (r.status !== 0) throw new Error(`exit ${r.status}:\n${r.stderr}\n${r.stdout}`);
    const dest = join(dir, "Winter.app", HELPER_EMBED_RELATIVE);
    expect(existsSync(join(dest, "Contents", "MacOS", HELPER.dist.name))).toBe(true);
    const dr = spawnSync("codesign", ["-d", "-r-", dest], { encoding: "utf8" });
    expect(`${dr.stdout}${dr.stderr}`).toContain(`designated => ${helperRequirement(HELPER.dist.identifier, "37N77U9RSZ")}`);
    const dvv = spawnSync("codesign", ["-dvv", dest], { encoding: "utf8" }).stderr;
    expect(dvv).toMatch(/^Identifier=com\.winter\.computeruse$/m);
    expect(dvv).toMatch(/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime/m);
    const ents = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", dest], { encoding: "utf8" }).stdout;
    expect([...ents.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(["com.apple.security.automation.apple-events"]);
    expect(r.stdout).toContain("Winter Computer Use embedded at Contents/Helpers");
  });

  test("Release: winter-browser-host is signed with its OWN identity first — identifier, stated requirement, hardened runtime, no entitlements — and the helper's seal records it under that requirement", () => {
    const dir = builtProducts(HELPER.dist.identifier);
    const r = embed(dir);
    if (r.status !== 0) throw new Error(`exit ${r.status}:\n${r.stderr}\n${r.stdout}`);
    const dest = join(dir, "Winter.app", HELPER_EMBED_RELATIVE);
    const host = join(dest, "Contents", "MacOS", BROWSER_HOST_EXECUTABLE);
    const dr = spawnSync("codesign", ["-d", "-r-", host], { encoding: "utf8" });
    expect(`${dr.stdout}${dr.stderr}`).toContain(`designated => ${helperRequirement(BROWSER_HOST.dist.identifier, "37N77U9RSZ")}`);
    const dvv = spawnSync("codesign", ["-dvv", host], { encoding: "utf8" }).stderr;
    expect(dvv).toMatch(/^Identifier=com\.winter\.browserhost$/m);
    expect(dvv).toMatch(/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime/m);
    expect(spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", host], { encoding: "utf8" }).stdout).not.toContain("<key>");
    // Its own signature is intact after the helper's (signed first, never re-signed by it)…
    expect(spawnSync("codesign", ["--verify", "--strict", host], { encoding: "utf8" }).status).toBe(0);
    // …and the helper's seal records it as nested code under the host's stated requirement. (A strict --deep verify of
    // this ad-hoc fixture fails exactly there: an ad-hoc host cannot satisfy a team requirement; release.ts verifies the
    // real artifact, signed by Winter's team.)
    const sealed = spawnSync("plutil", ["-extract", `files2.MacOS/${BROWSER_HOST_EXECUTABLE}.requirement`, "raw", "-o", "-",
      join(dest, "Contents", "_CodeSignature", "CodeResources")], { encoding: "utf8" });
    expect(sealed.stdout.trim()).toBe(helperRequirement(BROWSER_HOST.dist.identifier, "37N77U9RSZ"));
  });

  test("refuses a helper built without winter-browser-host", () => {
    const dir = builtProducts(HELPER.dist.identifier, readHelperVersion(), false);
    const r = embed(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("has no Contents/MacOS/winter-browser-host");
    expect(existsSync(join(dir, "Winter.app", HELPER_EMBED_RELATIVE))).toBe(false);
  });

  test("a re-embed replaces the old copy rather than merging into it", () => {
    const dir = builtProducts(HELPER.dist.identifier);
    expect(embed(dir).status).toBe(0);
    const stray = join(dir, "Winter.app", HELPER_EMBED_RELATIVE, "Contents", "Resources", "stale.txt");
    mkdirSync(join(stray, ".."), { recursive: true });
    writeFileSync(stray, "left over");
    expect(embed(dir).status).toBe(0);
    expect(existsSync(stray)).toBe(false);
  });

  test("refuses a helper that is not at its own version (apple/ComputerUse/VERSION), naming the fix", () => {
    const dir = builtProducts(HELPER.dist.identifier, "0.124.0"); // Winter's version: the old, shared stamp
    const r = embed(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`the built helper is version '0.124.0', but apple/ComputerUse/VERSION says ${readHelperVersion()}`);
    expect(r.stderr).toContain("bun run version:sync");
    expect(existsSync(join(dir, "Winter.app", HELPER_EMBED_RELATIVE))).toBe(false);
  });

  test("refuses a missing build product, and a helper built with any identity but the shipped one", () => {
    const empty = mkdtempSync(join(tmpdir(), "embed-cu-"));
    temps.push(empty);
    const missing = embed(empty);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("the built helper is not at");

    const dev = embed(builtProducts(HELPER.dev.identifier));
    expect(dev.status).not.toBe(0);
    expect(dev.stderr).toContain("a Release Winter.app embeds only the dist helper");
  });
});
