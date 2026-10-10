// The manifest per flavor, the build, and what neither may ever contain.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, devKey, FORBIDDEN_IN_BUNDLE } from "../scripts/build";
import { extensionManifest, HOST_NAME, MINIMUM_CHROME_VERSION } from "../src/manifest";
import { drawOverlay, OVERLAY_TAG } from "../src/overlay";

const idFromKey = (key: string): string =>
  [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");

describe("the manifest", () => {
  test("exactly the spine's permissions, all sites, no content scripts, never in private windows", () => {
    for (const flavor of ["dev", "store"] as const) {
      const m = extensionManifest(flavor, devKey());
      expect(m.manifest_version).toBe(3);
      expect(m.permissions).toEqual(["debugger", "tabs", "tabGroups", "nativeMessaging", "scripting", "storage"]);
      expect(m.host_permissions).toEqual(["<all_urls>"]);
      expect(m.content_scripts).toBeUndefined();
      expect(m.optional_permissions).toBeUndefined();
      expect(m.incognito).toBe("not_allowed");
      expect(m.version).toBe("1.0.0");
      expect(m.minimum_chrome_version).toBe(MINIMUM_CHROME_VERSION);
    }
    expect(MINIMUM_CHROME_VERSION).toBe("125");
  });

  test("dev carries the key that fixes its id; store carries none", () => {
    const dev = extensionManifest("dev", devKey());
    expect(idFromKey(String(dev.key))).toBe("jikdcokcpbacalfeipkognejnlnobbbf");
    expect("key" in extensionManifest("store")).toBe(false);
    expect(() => extensionManifest("dev")).toThrow(/key/);
    expect(HOST_NAME).toEqual({ dev: "com.winter.browser.dev", store: "com.winter.browser" });
  });
});

describe("the build", () => {
  test("both flavors build, each bound to its own host, with nothing the extension must never do", async () => {
    const out = mkdtempSync(join(tmpdir(), "wfc-build-"));
    try {
      const [devDir, storeDir] = await build(["dev", "store"], out);
      for (const [dir, host] of [[devDir!, HOST_NAME.dev], [storeDir!, HOST_NAME.store]] as const) {
        expect(readdirSync(dir).sort()).toEqual(["background.js", "icons", "manifest.json", "popup.html", "popup.js"]);
        expect(readdirSync(join(dir, "icons")).sort()).toEqual(["128.png", "16.png", "32.png", "48.png"]);
        const bundle = readFileSync(join(dir, "background.js"), "utf8");
        expect(bundle).toContain(JSON.stringify(host));
        for (const file of ["background.js", "popup.js"]) {
          const text = readFileSync(join(dir, file), "utf8");
          for (const f of FORBIDDEN_IN_BUNDLE) expect({ file, why: f.why, hit: f.pattern.test(text) }).toEqual({ file, why: f.why, hit: false });
        }
        // The allowlist is the daemon's own, bundled from source.
        expect(bundle).toContain("Emulation.setFocusEmulationEnabled");
        expect(bundle).toContain("Page.setInterceptFileChooserDialog");
      }
      expect(JSON.parse(readFileSync(join(devDir!, "manifest.json"), "utf8")).key).toBe(devKey());
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  test("the build refuses a bundle that would (the scan covers popup.js too)", async () => {
    const { FORBIDDEN_IN_BUNDLE: forbidden } = await import("../scripts/build");
    expect(forbidden.some((f) => f.pattern.test("chrome.tabs.update(1, { active: true })"))).toBe(true);
    expect(forbidden.some((f) => f.pattern.test("chrome.windows.update(2, { focused: true })"))).toBe(true);
    expect(forbidden.some((f) => f.pattern.test("x.executeScript({ world: \"MAIN\" })"))).toBe(true);
    expect(readFileSync(join(import.meta.dir, "..", "scripts", "build.ts"), "utf8")).toContain('for (const file of ["background.js", "popup.js"])');
  });

  test("the sources never call what would move the user's view or read a site's data", () => {
    const dir = join(import.meta.dir, "..", "src");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const code = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const f of FORBIDDEN_IN_BUNDLE) expect({ file, why: f.why, hit: f.pattern.test(code) }).toEqual({ file, why: f.why, hit: false });
    }
  });

  test("the worker starts with the browser: it listens for onStartup and onInstalled at the top level", () => {
    const bg = readFileSync(join(import.meta.dir, "..", "src", "background.ts"), "utf8");
    expect(bg).toMatch(/^chrome\.runtime\.onStartup\.addListener\(/m);
    expect(bg).toMatch(/^chrome\.runtime\.onInstalled\.addListener\(/m);
  });

  test("the overlay function stands alone (Chrome serializes it) and draws under one tag", () => {
    const fn = new Function(`return (${drawOverlay.toString()});`)() as unknown;
    expect(typeof fn).toBe("function");
    expect(drawOverlay.toString()).toContain(`"${OVERLAY_TAG}"`);
    const src = drawOverlay.toString();
    expect(src).toContain('mode: "closed"');
    // An indicator only: nothing in it takes a pointer event (Stop is the toolbar button), and a page cannot restyle it.
    expect(src).not.toMatch(/createElement\(["']button["']\)|addEventListener/);
    expect(src).toContain("pointer-events: none !important");
    expect(src).toContain('host.style.setProperty(k, v, "important")');
    expect(src).toMatch(/\["pointer-events", "none"\]/);
  });
});
