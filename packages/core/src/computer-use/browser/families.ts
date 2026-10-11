// ComputerV2 Phase 2 — the browser families the engine knows, by the ids the model names them with, and the app
// each one is (its bundle ids: the user's browser is governed by the existing per-app model — one grant covers the
// browser as an app and its tabs). THE ONE TABLE: Winter for Chrome's host server reads it too (`browserForBundleId`,
// `familyName`); bundle ids compare without regard to case, names are stable.
import type { BrowserFamily } from "./transport";

export interface FamilyInfo {
  family: BrowserFamily;
  /** What a person calls the family: "Google Chrome". */
  name: string;
  /** The app's bundle ids, the main channel first (the one a grant and the per-app card name). Beta/Dev/Canary and
   *  Chrome for Testing are the same family. Empty for `winter` (Winter's own browser is no app the policy governs). */
  bundleIds: readonly string[];
}

/** Every known bundle id → its family and that channel's own name. */
const CHANNELS: ReadonlyArray<{ bundleId: string; family: BrowserFamily; name: string }> = [
  { bundleId: "com.google.Chrome", family: "chrome", name: "Google Chrome" },
  { bundleId: "com.google.Chrome.beta", family: "chrome", name: "Google Chrome Beta" },
  { bundleId: "com.google.Chrome.dev", family: "chrome", name: "Google Chrome Dev" },
  { bundleId: "com.google.Chrome.canary", family: "chrome", name: "Google Chrome Canary" },
  { bundleId: "com.google.chrome.for.testing", family: "chrome", name: "Google Chrome for Testing" },
  { bundleId: "com.microsoft.edgemac", family: "edge", name: "Microsoft Edge" },
  { bundleId: "com.microsoft.edgemac.Beta", family: "edge", name: "Microsoft Edge Beta" },
  { bundleId: "com.microsoft.edgemac.Dev", family: "edge", name: "Microsoft Edge Dev" },
  { bundleId: "com.microsoft.edgemac.Canary", family: "edge", name: "Microsoft Edge Canary" },
  { bundleId: "com.brave.Browser", family: "brave", name: "Brave" },
  { bundleId: "com.vivaldi.Vivaldi", family: "vivaldi", name: "Vivaldi" },
  { bundleId: "com.operasoftware.Opera", family: "opera", name: "Opera" },
  { bundleId: "company.thebrowser.Browser", family: "arc", name: "Arc" },
  { bundleId: "org.chromium.Chromium", family: "chromium", name: "Chromium" },
];

const FAMILY_NAMES: Readonly<Record<BrowserFamily, string>> = {
  winter: "Winter (built-in)", chrome: "Google Chrome", edge: "Microsoft Edge", brave: "Brave", vivaldi: "Vivaldi",
  opera: "Opera", arc: "Arc", chromium: "Chromium",
};

const ORDER: readonly BrowserFamily[] = ["winter", "chrome", "edge", "brave", "vivaldi", "opera", "arc", "chromium"];

export const BROWSER_FAMILIES: readonly FamilyInfo[] = ORDER.map((family) => ({
  family, name: FAMILY_NAMES[family], bundleIds: CHANNELS.filter((c) => c.family === family).map((c) => c.bundleId),
}));

const BY_FAMILY: ReadonlyMap<string, FamilyInfo> = new Map(BROWSER_FAMILIES.map((f) => [f.family, f]));
const BY_BUNDLE: ReadonlyMap<string, { bundleId: string; family: BrowserFamily; name: string }> = new Map(CHANNELS.map((c) => [c.bundleId.toLowerCase(), c]));

export function familyInfo(family: string): FamilyInfo | undefined { return BY_FAMILY.get(family); }

/** A family's display name ("Google Chrome"); undefined for an unknown id. */
export function familyName(family: string): string | undefined { return BY_FAMILY.get(family)?.name; }

/** A browser app by its bundle id (case-insensitive): its family, its channel's own name and the id as listed. */
export function browserForBundleId(bundleId: string): { bundleId: string; family: BrowserFamily; name: string } | undefined {
  return BY_BUNDLE.get(bundleId.toLowerCase());
}

/** The family a browser app belongs to, by its bundle id (case-insensitive) — undefined for anything else. */
export function familyForBundleId(bundleId: string): FamilyInfo | undefined {
  const hit = browserForBundleId(bundleId);
  return hit === undefined ? undefined : BY_FAMILY.get(hit.family);
}

/** `"chrome"`, `"chrome#2"` → the family part, when it names a known family. */
export function familyOfBackendId(id: string): BrowserFamily | undefined {
  const fam = id.split("#")[0] ?? "";
  return BY_FAMILY.has(fam) ? fam as BrowserFamily : undefined;
}
