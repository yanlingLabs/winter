// The Chromium family (Google Chrome and its channels, Microsoft Edge, Brave, Vivaldi, Opera, Arc, Chromium): its tabs
// and opening a URL in a new tab — through the dictionary these browsers share (`windows`, `tabs`, `URL`, `title`,
// `active tab index`; `make new tab`), never `execute … javascript` (the helper refuses it anywhere). A new tab is made
// at the end of the front window and the window's active tab is put back, so what the user looks at does not change.
import { AutomationFailure } from "../../errors";
import type { AppAdapter } from "../types";
import { appScript, rows, text, urlArg, yes } from "./common";

/** The family's bundle ids (the browsers' table in the Phase 2 spine, channels included). */
export const CHROMIUM_BUNDLE_IDS = [
  "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
  "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
  "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
  "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser", "org.chromium.Chromium",
] as const;

const GUIDE = `This browser's extras list its tabs and open a URL without touching any page or bringing the browser forward:
- tabs() lists every tab: its window id, its index, whether it is the window's active tab, its URL and title;
- openURL(url) opens a new tab at the end of the front window and keeps that window's active tab as it was; it returns where the new tab is ({ window, tab }).
For work inside a page — reading it, clicking, typing — bind the tab with browsers.tab(…, { browser }) (its id from browsers.tabs()) instead of this app's window: that drives the page itself, in the background.
The extras never run JavaScript in a page.`;

export const chromiumAdapter: AppAdapter = {
  bundleIds: CHROMIUM_BUNDLE_IDS,
  guide: { id: "chromium@1", text: GUIDE },
  extras: [
    {
      name: "tabs", access: "view",
      signature: "tabs(): Promise<{ window: number; tab: number; active: boolean; url: string; title: string }[]>",
      summary: "every tab of every window: window id, index, active, URL, title",
      doc: "Every window's tabs, front window first. window is the window's id, tab its index in the window (1 = leftmost), active the window's active tab.",
      async run(scope) {
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "set out to \"\"",
          "repeat with w in windows",
          "  try",
          "    set wid to id of w",
          "    set ai to 0",
          "    try",
          "      set ai to active tab index of w",
          "    end try",
          "    set i to 0",
          "    repeat with t in (tabs of w)",
          "      set i to i + 1",
          "      set out to out & wid & winterTAB & i & winterTAB & (i = ai) & winterTAB & my winterText(URL of t) & winterTAB & my winterText(title of t) & winterLF",
          "    end repeat",
          "  end try",
          "end repeat",
          "return out",
        ], { handlers: ["text"] }), { timeoutMs: 20_000 });
        return rows(result, 5).map(([w, t, active, url, title]) => ({ window: Number(w), tab: Number(t), active: yes(active), url: url ?? "", title: title ?? "" }));
      },
    },
    {
      name: "openURL", access: "full",
      signature: "openURL(url: string): Promise<{ window: number; tab: number }>",
      summary: "opens a URL in a new tab of the front window; the active tab stays",
      doc: "http, https or file URLs, in a new tab at the end of the front window; the window's active tab is set back to the one the user had. With no window it fails (NoWindow): Winter never opens a browser window in front of the user. Returns where the new tab is.",
      async run(scope, args) {
        const url = urlArg(args[0], "openURL(url)");
        const u = text(url);
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "if (count of windows) = 0 then return \"NOWINDOW\"",
          "set w to front window",
          "set ai to 0",
          "try",
          "  set ai to active tab index of w",
          "end try",
          `make new tab at end of tabs of w with properties {URL:${u}}`,
          "set n to count of tabs of w",
          "if ai > 0 then",
          "  try",
          "    set active tab index of w to ai",
          "  end try",
          "end if",
          "return ((id of w) as text) & winterTAB & (n as text)",
        ]), { timeoutMs: 15_000 });
        if ((result ?? "").trim() === "NOWINDOW") throw new AutomationFailure("NoWindow", `${scope.app.name} has no window to open a tab in — ask the user to open one (Winter never opens a browser window in front of them)`);
        const [row] = rows(result, 2);
        scope.say("opened the URL in a new tab at the end of the front window (its active tab is unchanged)");
        return { window: Number(row?.[0] ?? 0), tab: Number(row?.[1] ?? 0) };
      },
    },
  ],
};
