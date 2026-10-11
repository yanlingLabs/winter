// Winter for Chrome — its MV3 manifest, built per flavor by scripts/build.ts.
//  - store: what goes to the Chrome Web Store (publisher yanlingLabs); no `key` (the store assigns the id), and it talks
//    to the dist host `com.winter.browser`.
//  - edge: what goes to Edge Add-ons (publisher yanlingLabs) — the store build under the name "Winter for Edge" and
//    nothing else (a test holds the two to that); its own store-assigned id, the same host.
//  - dev: the unpacked build for Winter Dev; its `key` (keys/dev.pub, a public key) fixes its id, and it talks to
//    `com.winter.browser.dev`.
//
// `minimum_chrome_version` is the later of the two browser facts the extension relies on (stated in
// apple/ComputerUse/WinterBrowserHost/PROTOCOL.md): `chrome.debugger` flat child sessions (a `sessionId` in the
// debuggee, for out-of-process iframes) since Chrome 125, and an open native-messaging port keeping an MV3 service
// worker alive since Chrome 105.

export const EXTENSION_VERSION = "1.0.0";
export const MINIMUM_CHROME_VERSION = "125";

/** Exactly these (spine §6.5); a test pins the list. No `cookies`, no `history`, no `downloads`, no content scripts. */
export const PERMISSIONS = ["debugger", "tabs", "tabGroups", "nativeMessaging", "scripting", "storage"] as const;
export const HOST_PERMISSIONS = ["<all_urls>"] as const;

export type Flavor = "dev" | "store" | "edge";

export const FLAVORS: readonly Flavor[] = ["dev", "store", "edge"];

export const HOST_NAME: Readonly<Record<Flavor, string>> = { dev: "com.winter.browser.dev", store: "com.winter.browser", edge: "com.winter.browser" };

/** The name the user sees (the manifest, the toolbar, the popup and the status sentences; src/product.ts at run time). */
export const PRODUCT_NAMES: Readonly<Record<Flavor, string>> = { dev: "Winter for Chrome", store: "Winter for Chrome", edge: "Winter for Edge" };

export function extensionManifest(flavor: Flavor, devKey?: string): Record<string, unknown> {
  if (flavor === "dev" && (devKey === undefined || devKey === "")) throw new Error("the dev build needs its manifest key (keys/dev.pub)");
  const icons = { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" };
  return {
    manifest_version: 3,
    name: flavor === "dev" ? `${PRODUCT_NAMES.dev} (Dev)` : PRODUCT_NAMES[flavor],
    short_name: "Winter",
    description: "Lets Winter, the assistant on your Mac, work in this browser's tabs in the background when you ask it to.",
    version: EXTENSION_VERSION,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    permissions: [...PERMISSIONS],
    host_permissions: [...HOST_PERMISSIONS],
    // Never in private windows: it cannot be enabled there.
    incognito: "not_allowed",
    background: { service_worker: "background.js", type: "module" },
    action: { default_title: PRODUCT_NAMES[flavor], default_popup: "popup.html", default_icon: icons },
    icons,
    ...(flavor === "dev" ? { key: devKey } : {}),
  };
}
