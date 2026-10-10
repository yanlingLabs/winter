// ComputerV2 Phase 2 — the browser families the engine knows, by the ids the model names them with, and the app
// each one is (its bundle ids: the user's browser is governed by the existing per-app model — one grant covers the
// browser as an app and its tabs).
import type { BrowserFamily } from "./transport";

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
  { family: "chrome", name: "Google Chrome", bundleIds: ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary"] },
  { family: "edge", name: "Microsoft Edge", bundleIds: ["com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary"] },
  { family: "brave", name: "Brave", bundleIds: ["com.brave.Browser"] },
  { family: "vivaldi", name: "Vivaldi", bundleIds: ["com.vivaldi.Vivaldi"] },
  { family: "opera", name: "Opera", bundleIds: ["com.operasoftware.Opera"] },
  { family: "arc", name: "Arc", bundleIds: ["company.thebrowser.Browser"] },
  { family: "chromium", name: "Chromium", bundleIds: ["org.chromium.Chromium"] },
];

const BY_FAMILY: ReadonlyMap<string, FamilyInfo> = new Map(BROWSER_FAMILIES.map((f) => [f.family, f]));

export function familyInfo(family: string): FamilyInfo | undefined { return BY_FAMILY.get(family); }

/** The family a browser app belongs to, by its bundle id (exact, case-insensitive) — undefined for anything else. */
export function familyForBundleId(bundleId: string): FamilyInfo | undefined {
  const want = bundleId.toLowerCase();
  return BROWSER_FAMILIES.find((f) => f.bundleIds.some((b) => b.toLowerCase() === want));
}

/** `"chrome"`, `"chrome#2"` → the family part, when it names a known family. */
export function familyOfBackendId(id: string): BrowserFamily | undefined {
  const fam = id.split("#")[0] ?? "";
  return BY_FAMILY.has(fam) ? fam as BrowserFamily : undefined;
}
