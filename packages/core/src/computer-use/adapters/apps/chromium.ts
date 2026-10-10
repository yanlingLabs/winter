// The Chromium family (Google Chrome and its channels, Microsoft Edge, Brave, Vivaldi, Opera, Arc, Chromium): a GUIDE
// and no extras. Their dictionary names a window by the browser's own session number, not by the window-server id the
// bind holds, and offers nothing else that matches one window exactly (bounds and titles are not identities) — so an
// extra could not be sure to act in the BOUND window rather than one of the user's, and Winter offers none: it never
// guesses which window to act in. Their dictionary commands (`.dict`) take only references the model writes itself;
// `execute … javascript` is refused by the helper wherever it is sent.
import { CHROMIUM_GUIDE } from "../guides/chromium";
import type { AppAdapter } from "../types";

/** The family's bundle ids (each browser's, its beta/dev/canary channels included). */
export const CHROMIUM_BUNDLE_IDS = [
  "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
  "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
  "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
  "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser", "org.chromium.Chromium",
] as const;

export const chromiumAdapter: AppAdapter = {
  bundleIds: CHROMIUM_BUNDLE_IDS,
  guide: { id: "chromium@2", text: CHROMIUM_GUIDE },
  extras: [],
};
