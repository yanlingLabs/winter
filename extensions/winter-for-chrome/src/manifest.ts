// Winter for Chrome — its MV3 manifest, built per flavor by scripts/build.ts.
//  - store: what goes to the Chrome Web Store and Edge Add-ons (publisher yanlingLabs); no `key` (the stores assign the
//    id), and it talks to the dist host `com.winter.browser`.
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

export type Flavor = "dev" | "store";

export const HOST_NAME: Readonly<Record<Flavor, string>> = { dev: "com.winter.browser.dev", store: "com.winter.browser" };

export function extensionManifest(flavor: Flavor, devKey?: string): Record<string, unknown> {
  if (flavor === "dev" && (devKey === undefined || devKey === "")) throw new Error("the dev build needs its manifest key (keys/dev.pub)");
  const icons = { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" };
  return {
    manifest_version: 3,
    name: flavor === "dev" ? "Winter for Chrome (Dev)" : "Winter for Chrome",
    short_name: "Winter",
    description: "Lets Winter, the assistant on your Mac, work in this browser's tabs in the background when you ask it to.",
    version: EXTENSION_VERSION,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    permissions: [...PERMISSIONS],
    host_permissions: [...HOST_PERMISSIONS],
    // Never in private windows: it cannot be enabled there.
    incognito: "not_allowed",
    background: { service_worker: "background.js", type: "module" },
    action: { default_title: "Winter for Chrome", default_popup: "popup.html", default_icon: icons },
    icons,
    ...(flavor === "dev" ? { key: devKey } : {}),
  };
}
