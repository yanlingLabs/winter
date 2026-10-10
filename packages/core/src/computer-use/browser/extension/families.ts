// ComputerV2 Phase 2 — which browser apps may host Winter for Chrome, by the bundle id `winter-browser-host` reports
// for its parent process. A bundle id not listed here is refused at `host.hello` (`not_allowed`, reason "browser").
//
// INTERIM COPY of lane B's `browser/families.ts` — the same exported names, shapes, names and case handling — kept here
// until that file is on main; then the host server imports B's `familyForBundleId` instead and this file goes. B's list
// carries Chrome for Testing in the chrome family and Edge's Beta/Dev/Canary channels, as this one does.
import type { BrowserFamily } from "../transport";

export interface FamilyInfo {
  family: BrowserFamily;
  /** What a person calls it: "Google Chrome". */
  name: string;
  /** The app's bundle ids; the first is the one a grant and the per-app card name. Beta/Dev/Canary channels are the
   *  same family. Empty for `winter` (Winter's own browser is no app the policy governs). */
  bundleIds: readonly string[];
}

export const BROWSER_FAMILIES: readonly FamilyInfo[] = [
  { family: "winter", name: "Winter (built-in)", bundleIds: [] },
  { family: "chrome", name: "Google Chrome", bundleIds: ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "com.google.chrome.for.testing"] },
  { family: "edge", name: "Microsoft Edge", bundleIds: ["com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary"] },
  { family: "brave", name: "Brave", bundleIds: ["com.brave.Browser"] },
  { family: "vivaldi", name: "Vivaldi", bundleIds: ["com.vivaldi.Vivaldi"] },
  { family: "opera", name: "Opera", bundleIds: ["com.operasoftware.Opera"] },
  { family: "arc", name: "Arc", bundleIds: ["company.thebrowser.Browser"] },
  { family: "chromium", name: "Chromium", bundleIds: ["org.chromium.Chromium"] },
];

/** The family a browser app belongs to, by its bundle id (exact, case-insensitive) — undefined for anything else. */
export function familyForBundleId(bundleId: string): FamilyInfo | undefined {
  const want = bundleId.toLowerCase();
  return BROWSER_FAMILIES.find((f) => f.bundleIds.some((b) => b.toLowerCase() === want));
}
