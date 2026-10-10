// ComputerV2 Phase 2 — which browser apps may host Winter for Chrome, by the bundle id `winter-browser-host` reports
// for its parent process. Each is the app the per-app card and access settings name (one grant covers the app and its
// tabs). A bundle id not listed here is refused at `host.hello` (`not_allowed`, reason "browser").
import type { BrowserFamily } from "../transport";

export interface BrowserApp {
  family: Exclude<BrowserFamily, "winter">;
  /** The app's name as the model and Settings see it ("Google Chrome"). */
  name: string;
}

/** Bundle id → family. A family's channels (Beta, Dev, Canary) are the same family; Chrome for Testing is Chrome. */
export const BROWSER_APPS: Readonly<Record<string, BrowserApp>> = {
  "com.google.Chrome": { family: "chrome", name: "Google Chrome" },
  "com.google.Chrome.beta": { family: "chrome", name: "Google Chrome Beta" },
  "com.google.Chrome.dev": { family: "chrome", name: "Google Chrome Dev" },
  "com.google.Chrome.canary": { family: "chrome", name: "Google Chrome Canary" },
  "com.google.chrome.for.testing": { family: "chrome", name: "Google Chrome for Testing" },
  "com.microsoft.edgemac": { family: "edge", name: "Microsoft Edge" },
  "com.microsoft.edgemac.Beta": { family: "edge", name: "Microsoft Edge Beta" },
  "com.microsoft.edgemac.Dev": { family: "edge", name: "Microsoft Edge Dev" },
  "com.microsoft.edgemac.Canary": { family: "edge", name: "Microsoft Edge Canary" },
  "com.brave.Browser": { family: "brave", name: "Brave Browser" },
  "com.vivaldi.Vivaldi": { family: "vivaldi", name: "Vivaldi" },
  "com.operasoftware.Opera": { family: "opera", name: "Opera" },
  "company.thebrowser.Browser": { family: "arc", name: "Arc" },
  "org.chromium.Chromium": { family: "chromium", name: "Chromium" },
};

export function browserAppFor(bundleId: string): BrowserApp | undefined {
  return Object.hasOwn(BROWSER_APPS, bundleId) ? BROWSER_APPS[bundleId] : undefined;
}
