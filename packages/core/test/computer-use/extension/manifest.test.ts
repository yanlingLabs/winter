// The native-messaging host manifest writer, into temp directories only (never the user's Application Support).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedOrigins, EXTENSION_IDS, NATIVE_HOST_NAME } from "../../../src/computer-use/browser/extension/extension-ids";
import { hostManifest, hostManifestText, NATIVE_MESSAGING_BROWSER_DIRS, writeHostManifests, writeManifestInto } from "../../../src/computer-use/browser/extension/manifest";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "winter-nm-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const devManifest = () => hostManifest({
  name: NATIVE_HOST_NAME.dev,
  path: "/repo/dist/dev/Winter Computer Use Dev.app/Contents/MacOS/winter-browser-host",
  allowedOrigins: allowedOrigins(EXTENSION_IDS.dev),
});

describe("hostManifest", () => {
  test("the spine's shape: name, description, stdio, an absolute path, the allowed origins", () => {
    expect(devManifest()).toEqual({
      name: "com.winter.browser.dev",
      description: "Winter for Chrome",
      path: "/repo/dist/dev/Winter Computer Use Dev.app/Contents/MacOS/winter-browser-host",
      type: "stdio",
      allowed_origins: ["chrome-extension://jikdcokcpbacalfeipkognejnlnobbbf/"],
    });
    expect(hostManifestText(devManifest()).endsWith("}\n")).toBe(true);
    expect(() => hostManifest({ name: "x", path: "relative/host", allowedOrigins: [] })).toThrow(/absolute/);
  });
});

describe("writeHostManifests", () => {
  test("writes only into browsers whose support directory exists, creating NativeMessagingHosts", () => {
    mkdirSync(join(root, "Google", "Chrome"), { recursive: true });
    mkdirSync(join(root, "Arc", "User Data"), { recursive: true });
    mkdirSync(join(root, "Microsoft Edge"), { recursive: true });
    const outcomes = writeHostManifests(root, devManifest());
    expect(outcomes.filter((o) => o.outcome === "written").map((o) => o.dir)).toEqual(["Google/Chrome", "Microsoft Edge", "Arc/User Data"]);
    expect(outcomes.filter((o) => o.outcome === "skipped")).toHaveLength(NATIVE_MESSAGING_BROWSER_DIRS.length - 3);
    const file = join(root, "Google", "Chrome", "NativeMessagingHosts", "com.winter.browser.dev.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(devManifest());
    expect(existsSync(join(root, "Chromium"))).toBe(false); // never creates a browser's own directory
  });

  test("writes nothing when the content is already there (the mtime stays), rewrites when it differs", async () => {
    mkdirSync(join(root, "Chromium"), { recursive: true });
    writeHostManifests(root, devManifest());
    const file = join(root, "Chromium", "NativeMessagingHosts", "com.winter.browser.dev.json");
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    expect(writeHostManifests(root, devManifest()).find((o) => o.dir === "Chromium")?.outcome).toBe("unchanged");
    expect(statSync(file).mtimeMs).toBe(before);
    const moved = hostManifest({ ...devManifest(), allowedOrigins: devManifest().allowed_origins, path: "/elsewhere/winter-browser-host" });
    expect(writeHostManifests(root, moved).find((o) => o.dir === "Chromium")?.outcome).toBe("written");
    expect(JSON.parse(readFileSync(file, "utf8")).path).toBe("/elsewhere/winter-browser-host");
  });

  test("never deletes: other manifests beside it stay, and no temp file is left behind", () => {
    const nm = join(root, "Vivaldi", "NativeMessagingHosts");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "com.other.host.json"), "{}");
    writeHostManifests(root, devManifest());
    expect(readdirSync(nm).sort()).toEqual(["com.other.host.json", "com.winter.browser.dev.json"]);
  });

  test("writeManifestInto: a temp profile's own NativeMessagingHosts (what the e2e uses)", () => {
    const nm = join(root, "profile", "NativeMessagingHosts");
    expect(writeManifestInto(nm, devManifest())).toBe("written");
    expect(writeManifestInto(nm, devManifest())).toBe("unchanged");
    expect((statSync(join(nm, "com.winter.browser.dev.json")).mode & 0o777)).toBe(0o644);
  });
});
