// ComputerV2 Phase 4 — the STANDALONE proof of `embed-headless-helper.sh` (the body of project.yml's "Embed Winter
// Headless" postCompileScript), run the way Xcode runs it: BUILT_PRODUCTS_DIR=<mkdtemp>,
// CONTENTS_FOLDER_PATH=Winter.app/Contents, CONFIGURATION=Release, EXPANDED_CODE_SIGN_IDENTITY=- (ad-hoc: this proves the
// build phase; release.ts checks the Developer ID team, the timestamp and that the stated requirement is satisfied on
// the real artifact).
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSignedHeadless, HEADLESS, HEADLESS_EMBED_RELATIVE, HEADLESS_NESTED_HELPERS, headlessBuildArgs, headlessRequirement, headlessSignArgs, signedFacts } from "./headless-helper-lib";

const SCRIPT = join(import.meta.dir, "embed-headless-helper.sh");
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A built-products dir holding a minimal "Winter Headless.app". */
function builtProducts(o: { bundleId?: string; backgroundOnly?: boolean; frameworks?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "embed-headless-"));
  temps.push(dir);
  const app = join(dir, `${HEADLESS.dist.name}.app`, "Contents");
  mkdirSync(join(app, "MacOS"), { recursive: true });
  copyFileSync("/usr/bin/true", join(app, "MacOS", HEADLESS.dist.name));
  if (o.frameworks === true) mkdirSync(join(app, "Frameworks"), { recursive: true });
  writeFileSync(
    join(app, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${HEADLESS.dist.name}</string>
<key>CFBundleIdentifier</key><string>${o.bundleId ?? HEADLESS.dist.identifier}</string>
<key>CFBundlePackageType</key><string>APPL</string>
${o.backgroundOnly === false ? "" : "<key>LSBackgroundOnly</key><true/>"}
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

describe("embed-headless-helper.sh (the 'Embed Winter Headless' postCompileScript, standalone)", () => {
  test("a non-Release build embeds nothing", () => {
    const dir = builtProducts();
    const r = embed(dir, "Debug");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skip Winter Headless embed (non-Release)");
    expect(existsSync(join(dir, "Winter.app", HEADLESS_EMBED_RELATIVE))).toBe(false);
  });

  test("Release: copies the helper into Contents/Helpers and signs it with the stated requirement, the hardened runtime and no entitlements", () => {
    const dir = builtProducts();
    const r = embed(dir);
    if (r.status !== 0) throw new Error(`exit ${r.status}:\n${r.stderr}\n${r.stdout}`);
    const dest = join(dir, "Winter.app", HEADLESS_EMBED_RELATIVE);
    expect(existsSync(join(dest, "Contents", "MacOS", HEADLESS.dist.name))).toBe(true);
    const dr = spawnSync("codesign", ["-d", "-r-", dest], { encoding: "utf8" });
    expect(`${dr.stdout}${dr.stderr}`).toContain(`designated => ${headlessRequirement(HEADLESS.dist.identifier, "37N77U9RSZ")}`);
    const dvv = spawnSync("codesign", ["-dvv", dest], { encoding: "utf8" }).stderr;
    expect(dvv).toMatch(/^Identifier=com\.winter\.headless$/m);
    expect(dvv).toMatch(/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime/m);
    expect(spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", dest], { encoding: "utf8" }).stdout).not.toContain("<key>");
    expect(r.stdout).toContain("embedded Winter Headless (com.winter.headless, hardened runtime, no entitlements, stated requirement)");
  });

  test("refuses another identity, a helper that is not background-only, and a self-contained build", () => {
    for (const [o, message] of [
      [{ bundleId: HEADLESS.dev.identifier }, "a Release Winter.app embeds only the dist helper"],
      [{ backgroundOnly: false }, "is not LSBackgroundOnly"],
      [{ frameworks: true }, "carries its own Contents/Frameworks"],
    ] as const) {
      const dir = builtProducts(o);
      const r = embed(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      expect(existsSync(join(dir, "Winter.app", HEADLESS_EMBED_RELATIVE))).toBe(false);
    }
  });

  test("a re-embed replaces the old copy rather than merging into it", () => {
    const dir = builtProducts();
    expect(embed(dir).status).toBe(0);
    const stray = join(dir, "Winter.app", HEADLESS_EMBED_RELATIVE, "Contents", "Resources", "stale.txt");
    mkdirSync(join(stray, ".."), { recursive: true });
    writeFileSync(stray, "left over");
    expect(embed(dir).status).toBe(0);
    expect(existsSync(stray)).toBe(false);
  });
});

describe("headless-helper-lib", () => {
  const good = {
    codesignDvv: "Identifier=com.winter.headless\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded\nTeamIdentifier=TEAM\n",
    codesignDr: `designated => ${headlessRequirement("com.winter.headless", "TEAM")}`,
    entitlementsXml: "",
    infoPlist: { CFBundleIdentifier: "com.winter.headless", CFBundleName: "Winter Headless", LSBackgroundOnly: true, CFBundleShortVersionString: "1.2.3" },
    hasFrameworks: false,
  };

  test("a signed release helper passes; every way it can be wrong is named", () => {
    expect(checkSignedHeadless("dist", "TEAM", "1.2.3", good)).toEqual([]);
    expect(checkSignedHeadless("dist", "TEAM", "1.2.3", { ...good, entitlementsXml: "<key>com.apple.security.get-task-allow</key><true/>" }))
      .toEqual(["carries entitlements (com.apple.security.get-task-allow); it must carry none"]);
    expect(checkSignedHeadless("dist", "TEAM", "1.2.3", { ...good, hasFrameworks: true }))
      .toEqual(["it carries its own Contents/Frameworks — a release borrows Winter.app's Chromium (never a second copy)"]);
    expect(checkSignedHeadless("dist", "TEAM", "1.2.3", { ...good, infoPlist: { ...good.infoPlist, LSBackgroundOnly: false } }))
      .toEqual(["Info.plist LSBackgroundOnly is not true (it must have no Dock tile and no menu bar)"]);
    expect(checkSignedHeadless("dist", "TEAM", "1.2.4", good)).toEqual(["Info.plist CFBundleShortVersionString is 1.2.3, expected 1.2.4"]);
    expect(checkSignedHeadless("dist", "TEAM", "1.2.3", { ...good, codesignDvv: good.codesignDvv.replace("(runtime)", "(none)") }))
      .toEqual(["not signed with the hardened runtime (--options runtime)"]);
    expect(checkSignedHeadless("dist", "TEAM", "1.2.3", { ...good, codesignDr: "designated => identifier \"com.winter.headless\" and certificate leaf = H\"abc\"" })[0])
      .toMatch(/^designated requirement is identifier/);
  });

  test("a self-contained build's nested helpers keep their own identifiers (never the helper's)", () => {
    const own = Object.fromEntries(HEADLESS_NESTED_HELPERS.map((n, i) => [n, `com.winter.app.cefhelper${i === 0 ? "" : `.${i}`}`]));
    const dev = { ...good, codesignDvv: good.codesignDvv.replace("com.winter.headless", "com.winter.headless.dev"), codesignDr: `designated => ${headlessRequirement("com.winter.headless.dev", "TEAM")}`,
      infoPlist: { ...good.infoPlist, CFBundleIdentifier: "com.winter.headless.dev", CFBundleName: "Winter Headless Dev" }, hasFrameworks: true };
    expect(checkSignedHeadless("dev", "TEAM", "1.2.3", { ...dev, nestedIdentifiers: own })).toEqual([]);
    expect(checkSignedHeadless("dev", "TEAM", "1.2.3", { ...dev, nestedIdentifiers: { ...own, "Winter Helper (GPU)": "com.winter.headless.dev" } }))
      .toEqual(["the nested Winter Helper (GPU).app carries the helper's own identifier com.winter.headless.dev — the build renamed every target (a command-line PRODUCT_BUNDLE_IDENTIFIER)"]);
    expect(checkSignedHeadless("dev", "TEAM", "1.2.3", { ...dev, nestedIdentifiers: { ...own, "Winter Helper": undefined } }))
      .toEqual(["the nested Winter Helper.app is missing or unsigned"]);
  });

  test("the dev build names its identity through the helper's own setting, never a build-wide PRODUCT_BUNDLE_IDENTIFIER", () => {
    const args = headlessBuildArgs({ derivedDataPath: "/dd" });
    expect(args).toContain("WINTER_HEADLESS_DEBUG_BUNDLE_ID=com.winter.headless.dev");
    expect(args.some((a) => a.startsWith("PRODUCT_BUNDLE_IDENTIFIER="))).toBe(false);
    const yml = readFileSync(join(import.meta.dir, "..", "apple", "Winter", "project.yml"), "utf8");
    expect(yml).toContain("          PRODUCT_BUNDLE_IDENTIFIER: $(WINTER_HEADLESS_DEBUG_BUNDLE_ID)\n");
    expect(yml).toContain("        WINTER_HEADLESS_DEBUG_BUNDLE_ID: com.winter.headless.xcode-debug\n");
  });

  test("the dev helper must be self-contained", () => {
    const dev = { ...good, codesignDvv: good.codesignDvv.replace("com.winter.headless", "com.winter.headless.dev"), codesignDr: `designated => ${headlessRequirement("com.winter.headless.dev", "TEAM")}`,
      infoPlist: { ...good.infoPlist, CFBundleIdentifier: "com.winter.headless.dev", CFBundleName: "Winter Headless Dev" }, hasFrameworks: true };
    expect(checkSignedHeadless("dev", "TEAM", "1.2.3", dev)).toEqual([]);
    expect(checkSignedHeadless("dev", "TEAM", "1.2.3", { ...dev, hasFrameworks: false })[0]).toMatch(/no Contents\/Frameworks/);
  });

  test("the signing arguments never use --deep, state the requirement and carry no entitlements", () => {
    const args = headlessSignArgs({ identityHash: "ABC", flavor: "dev", teamId: "TEAM", appPath: "/x.app" });
    expect(args).not.toContain("--deep");
    expect(args.some((a) => a.startsWith("--entitlements"))).toBe(false);
    expect(args).toContain(`-r=designated => ${headlessRequirement("com.winter.headless.dev", "TEAM")}`);
    expect(args.slice(0, 7)).toEqual(["--force", "--sign", "ABC", "--identifier", "com.winter.headless.dev", "--options", "runtime"]);
    expect(signedFacts("Identifier=x\nTeamIdentifier=not set\nCodeDirectory flags=0x2(adhoc)")).toEqual({ identifier: "x", runtime: false });
  });
});
