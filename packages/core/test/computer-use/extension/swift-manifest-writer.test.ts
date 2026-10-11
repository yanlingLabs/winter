// Winter.app's Release manifest writer (apple/Winter/Sources/BrowserExtension/BrowserHostManifest.swift), compiled on
// its own with `swiftc` and a small driver (running WinterAppTests would launch a Winter): it writes only from an
// installed location, and its manifest is byte for byte what the daemon-side TS writer produces for the same inputs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedOrigins, NATIVE_HOST_NAME } from "../../../src/computer-use/browser/extension/extension-ids";
import { hostManifest, hostManifestText, writeHostManifests } from "../../../src/computer-use/browser/extension/manifest";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const SOURCE = join(REPO, "apple", "Winter", "Sources", "BrowserExtension", "BrowserHostManifest.swift");
const swiftc = process.platform === "darwin" ? spawnSync("xcrun", ["-f", "swiftc"], { encoding: "utf8" }).stdout.trim() : "";
const available = swiftc !== "" && existsSync(SOURCE);

let dir = "";
let driver = "";

const DRIVER = `
import Foundation
let a = CommandLine.arguments
switch a[1] {
case "content":
  let ids = a[3].isEmpty ? [] : a[3].split(separator: ",").map(String.init)
  if let d = BrowserHostManifest.content(hostPath: a[2], extensionIds: ids) { FileHandle.standardOutput.write(d) } else { print("<none>", terminator: "") }
case "installed":
  print(BrowserHostManifest.isInstalledLocation(appPath: a[2], userHome: a[3]) ? "yes" : "no", terminator: "")
case "write":
  let ids = a[4].isEmpty ? [] : a[4].split(separator: ",").map(String.init)
  for (dir, outcome) in BrowserHostManifest.write(appBundlePath: a[2], supportRoot: a[3], extensionIds: ids) { print("\\(dir)=\\(outcome)") }
default: exit(2)
}
`;

beforeAll(() => {
  if (!available) return;
  dir = mkdtempSync(join(tmpdir(), "winter-swift-manifest-"));
  writeFileSync(join(dir, "main.swift"), DRIVER);
  driver = join(dir, "driver");
  const built = spawnSync("xcrun", ["swiftc", "-o", driver, SOURCE, join(dir, "main.swift")], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`swiftc failed:\n${built.stderr}`);
}, 180_000);

afterAll(() => { if (dir !== "") rmSync(dir, { recursive: true, force: true }); });

const run = (...args: string[]): string => {
  const r = spawnSync(driver, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`driver ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
};

describe.skipIf(!available)("Winter.app's manifest writer (Swift)", () => {
  const ids = ["abcdefghijklmnopabcdefghijklmnop", "ponmlkjihgfedcbaponmlkjihgfedcba"];

  test("its manifest is byte for byte the TS writer's, for the same inputs (spaces, quotes, non-ASCII, control characters)", () => {
    for (const path of [
      "/Applications/Winter.app/Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host",
      "/Users/someone/Applications/Wïnter \"β\".app/Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host",
      "/tmp/back\\slash/tab\there/ctl\u0001\u0008\u000c/winter-browser-host",
    ]) {
      for (const list of [ids, [ids[0]!]]) {
        const ts = hostManifestText(hostManifest({ name: NATIVE_HOST_NAME.dist, path, allowedOrigins: allowedOrigins(list) }));
        expect({ path, swift: run("content", path, list.join(",")) }).toEqual({ path, swift: ts });
      }
    }
    expect(run("content", "/Applications/Winter.app/x", "")).toBe("<none>"); // no store ids: nothing at all
    expect(run("content", "relative/x", ids.join(","))).toBe("<none>");
  });

  test("it writes only from an installed location: /Applications or ~/Applications, never a disk image, a download, a build folder or a translocated copy", () => {
    const home = "/Users/someone";
    const yes = ["/Applications/Winter.app", "/Applications/Utilities/Winter.app", `${home}/Applications/Winter.app`];
    const no = ["/Volumes/Winter/Winter.app", `${home}/Downloads/Winter.app`, "/private/var/folders/x1/abc/T/AppTranslocation/0E3B/d/Winter.app",
      "/Applications/AppTranslocation/Winter.app", "/Applications", "/ApplicationsOld/Winter.app", `${home}/repo/out/release/0.124.0/Winter.app`, "/Applications/Winter"];
    for (const p of yes) expect({ p, installed: run("installed", p, home) }).toEqual({ p, installed: "yes" });
    for (const p of no) expect({ p, installed: run("installed", p, home) }).toEqual({ p, installed: "no" });
  });

  test("written into existing browser directories only, and equal to the TS writer's files", () => {
    const swiftRoot = mkdtempSync(join(tmpdir(), "winter-swift-nm-"));
    const tsRoot = mkdtempSync(join(tmpdir(), "winter-ts-nm-"));
    try {
      for (const root of [swiftRoot, tsRoot]) {
        mkdirSync(join(root, "Google", "Chrome"), { recursive: true });
        mkdirSync(join(root, "Arc", "User Data"), { recursive: true });
      }
      const app = "/Applications/Winter.app";
      const out = run("write", app, swiftRoot, ids.join(","));
      expect(out).toContain("Google/Chrome=written");
      expect(out).toContain("Arc/User Data=written");
      expect(out).toContain("Chromium=skipped");
      writeHostManifests(tsRoot, hostManifest({ name: NATIVE_HOST_NAME.dist, path: `${app}/Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host`, allowedOrigins: allowedOrigins(ids) }));
      for (const d of ["Google/Chrome", "Arc/User Data"]) {
        const f = (root: string) => readFileSync(join(root, d, "NativeMessagingHosts", "com.winter.browser.json"));
        expect(Buffer.compare(f(swiftRoot), f(tsRoot))).toBe(0);
      }
      expect(run("write", app, swiftRoot, ids.join(","))).toContain("Google/Chrome=unchanged");
      expect(existsSync(join(swiftRoot, "Chromium"))).toBe(false);
    } finally {
      rmSync(swiftRoot, { recursive: true, force: true });
      rmSync(tsRoot, { recursive: true, force: true });
    }
  });
});
