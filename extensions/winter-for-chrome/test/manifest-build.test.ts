// The manifest per flavor, the build, and what neither may ever contain.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_EXACT_CALLS, build, devKey, FORBIDDEN_IN_BUNDLE, forbiddenHits } from "../scripts/build";
import { extensionManifest, FLAVORS, HOST_NAME, MINIMUM_CHROME_VERSION, PRODUCT_NAMES } from "../src/manifest";
import { drawOverlay, OVERLAY_TAG } from "../src/overlay";

const idFromKey = (key: string): string =>
  [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");

describe("the manifest", () => {
  test("exactly the spine's permissions (and the optional ones), all sites, no content scripts, never in private windows", () => {
    for (const flavor of FLAVORS) {
      const m = extensionManifest(flavor, devKey());
      expect(m.manifest_version).toBe(3);
      expect(m.permissions).toEqual(["debugger", "tabs", "tabGroups", "nativeMessaging", "scripting", "storage"]);
      expect(m.host_permissions).toEqual(["<all_urls>"]);
      expect(m.content_scripts).toBeUndefined();
      // 1.1.0: the optional permissions, asked for in the popup only (an update from 1.0.0 carries no new warning).
      expect(m.optional_permissions).toEqual(["history", "bookmarks", "downloads"]);
      expect(m.incognito).toBe("not_allowed");
      expect(m.version).toBe("1.2.0");
      expect(m.minimum_chrome_version).toBe(MINIMUM_CHROME_VERSION);
    }
    expect(MINIMUM_CHROME_VERSION).toBe("125");
  });

  test("dev carries the key that fixes its id; the store builds carry none", () => {
    const dev = extensionManifest("dev", devKey());
    expect(idFromKey(String(dev.key))).toBe("jikdcokcpbacalfeipkognejnlnobbbf");
    expect("key" in extensionManifest("store")).toBe(false);
    expect("key" in extensionManifest("edge")).toBe(false);
    expect(() => extensionManifest("dev")).toThrow(/key/);
    expect(HOST_NAME).toEqual({ dev: "com.winter.browser.dev", store: "com.winter.browser", edge: "com.winter.browser" });
  });

  test("the name the user sees: Winter for Chrome, and Winter for Edge on Edge Add-ons", () => {
    expect(PRODUCT_NAMES).toEqual({ dev: "Winter for Chrome", store: "Winter for Chrome", edge: "Winter for Edge" });
    expect(extensionManifest("dev", devKey()).name).toBe("Winter for Chrome (Dev)");
    for (const flavor of ["store", "edge"] as const) {
      const m = extensionManifest(flavor);
      expect(m.name).toBe(PRODUCT_NAMES[flavor]);
      expect((m.action as { default_title: string }).default_title).toBe(PRODUCT_NAMES[flavor]);
    }
  });
});

describe("the build", () => {
  test("every flavor builds, each bound to its own host, with nothing the extension must never do", async () => {
    const out = mkdtempSync(join(tmpdir(), "wfc-build-"));
    try {
      const [devDir, storeDir, edgeDir] = await build(["dev", "store", "edge"], out);
      for (const [dir, host] of [[devDir!, HOST_NAME.dev], [storeDir!, HOST_NAME.store], [edgeDir!, HOST_NAME.edge]] as const) {
        expect(readdirSync(dir).sort()).toEqual(["background.js", "icons", "manifest.json", "popup.html", "popup.js"]);
        expect(readdirSync(join(dir, "icons")).sort()).toEqual(["128.png", "16.png", "32.png", "48.png"]);
        const bundle = readFileSync(join(dir, "background.js"), "utf8");
        expect(bundle).toContain(JSON.stringify(host));
        for (const file of ["background.js", "popup.js"]) {
          const text = readFileSync(join(dir, file), "utf8");
          expect({ file, hits: forbiddenHits(text).map((f) => f.why) }).toEqual({ file, hits: [] });
        }
        // Each allowed exact call is in the service worker once (never stale), and not in the popup.
        for (const a of ALLOWED_EXACT_CALLS) {
          expect({ call: a.text, count: bundle.split(a.text).length - 1 }).toEqual({ call: a.text, count: 1 });
          expect(readFileSync(join(dir, "popup.js"), "utf8")).not.toContain(a.text);
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

  test("the edge build is the store build with only the visible name changed", async () => {
    const out = mkdtempSync(join(tmpdir(), "wfc-build-"));
    try {
      const [storeDir, edgeDir] = await build(["store", "edge"], out);
      const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort();
      expect(files(edgeDir!)).toEqual(files(storeDir!));
      const storeManifest = JSON.parse(readFileSync(join(storeDir!, "manifest.json"), "utf8")) as Record<string, unknown>;
      const edgeManifest = JSON.parse(readFileSync(join(edgeDir!, "manifest.json"), "utf8")) as Record<string, unknown>;
      expect(edgeManifest.name).toBe("Winter for Edge");
      expect((edgeManifest.action as { default_title: string }).default_title).toBe("Winter for Edge");
      // Everything else in the manifest — permissions, hosts, version, description, icons — is the store build's.
      const renamed: Record<string, unknown> = { ...edgeManifest, name: storeManifest.name, action: { ...(edgeManifest.action as object), default_title: "Winter for Chrome" } };
      expect(renamed).toEqual(storeManifest);
      for (const file of files(storeDir!)) {
        if (file === "manifest.json") continue;
        const store = readFileSync(join(storeDir!, file));
        const edge = readFileSync(join(edgeDir!, file));
        if (file.endsWith(".png")) {
          expect({ file, same: edge.equals(store) }).toEqual({ file, same: true });
          continue;
        }
        const edgeText = edge.toString("utf8");
        // The Edge build never calls itself the Chrome one, and differs from it in nothing but that name.
        expect({ file, chromeName: edgeText.includes("Winter for Chrome") }).toEqual({ file, chromeName: false });
        expect({ file, text: edgeText.replaceAll("Winter for Edge", "Winter for Chrome") }).toEqual({ file, text: store.toString("utf8") });
        if (file !== "background.js") expect(edgeText).toContain("Winter for Edge");
      }
      expect(readFileSync(join(edgeDir!, "background.js"), "utf8")).toContain("Winter for Edge");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  test("the build refuses a bundle that would (the scan covers popup.js too)", async () => {
    const { FORBIDDEN_IN_BUNDLE: forbidden } = await import("../scripts/build");
    expect(forbidden.some((f) => f.pattern.test("chrome.tabs.update(1, { active: true })"))).toBe(true);
    expect(forbidden.some((f) => f.pattern.test("chrome.windows.update(2, { focused: true })"))).toBe(true);
    expect(forbidden.some((f) => f.pattern.test("x.executeScript({ world: \"MAIN\" })"))).toBe(true);
    // An allowed exact call is allowed only as spelled: anything more around it still fails.
    expect(forbiddenHits("chrome.tabs.update(tabId, { muted })")).toEqual([]);
    expect(forbiddenHits("chrome.tabs.update(tabId, { muted, active: true })").length).toBeGreaterThan(0);
    expect(forbiddenHits("chrome.tabs.update(tabId, { muted }); chrome.tabs.update(1, {})").length).toBeGreaterThan(0);
    expect(readFileSync(join(import.meta.dir, "..", "scripts", "build.ts"), "utf8")).toContain('for (const file of ["background.js", "popup.js"])');
  });

  test("the sources never call what would move the user's view or read a site's data — the allowed exact calls only in background.ts", () => {
    const dir = join(import.meta.dir, "..", "src");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const code = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect({ file, hits: forbiddenHits(code).map((f) => f.why) }).toEqual({ file, hits: [] });
      for (const a of ALLOWED_EXACT_CALLS) expect({ file, call: a.text, count: code.split(a.text).length - 1 }).toEqual({ file, call: a.text, count: file === "background.ts" ? 1 : 0 });
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
