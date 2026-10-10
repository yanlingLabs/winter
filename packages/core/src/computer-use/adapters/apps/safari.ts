// Safari (`com.apple.Safari`, and Safari Technology Preview): the BOUND window's tabs, its page's URL and text, and
// opening a URL — through its dictionary (`URL`, `name` and `text` of a tab; `make new tab`), never `do JavaScript`
// (the helper refuses it anywhere). Every extra addresses the bound window by its id (`window id <it>`: Safari's
// scripting id of a window IS its window-server id), NEVER Safari's front window — the user's own window may be in front.
// A bound window Safari cannot find, or one that is not a browser window, is `NoWindow`; nothing falls back.
// `openWindow(url)` makes a window of the agent's own (found by the one new id) for when the user wants Safari itself —
// the agent's own browsing belongs in Winter's built-in browser (`browsers.open`).
import { AutomationFailure } from "../../errors";
import { SAFARI_GUIDE } from "../guides/safari";
import type { AdapterScope, AppAdapter } from "../types";
import { appScript, intArg, optsArg, rows, text, urlArg, yes } from "./common";

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });

/** The lines that put the bound window in `w` and its current tab in `ct` — or return a sentinel the extra turns into
 *  `NoWindow`. */
export function boundBrowserWindow(windowId: number): string[] {
  return [
    `if not (exists window id ${windowId}) then return "NOWINDOW"`,
    `set w to window id ${windowId}`,
    "try",
    "  set ct to current tab of w",
    "on error",
    "  return \"NOTBROWSER\"",
    "end try",
  ];
}

/** A sentinel from `boundBrowserWindow` as the typed failure; the result itself otherwise. */
export function checkBound(scope: AdapterScope, result: string | null): string | null {
  const r = (result ?? "").trim();
  if (r === "NOWINDOW") {
    throw new AutomationFailure("NoWindow", `${scope.app.name} has no window with the bound window's id — it may have closed; bind a window again (apps.open, or useWindow). Nothing was done.`);
  }
  if (r === "NOTBROWSER") {
    throw new AutomationFailure("NoWindow", `the bound ${scope.app.name} window is not a browser window (it has no tabs) — bind a browser window: apps.open("${scope.app.name}", { window: <its title or id> }). Nothing was done.`);
  }
  return result;
}

const TAB_ROW = "my winterText(URL of t) & winterTAB & my winterText(name of t)";

export const safariAdapter: AppAdapter = {
  bundleIds: ["com.apple.Safari", "com.apple.SafariTechnologyPreview"],
  guide: { id: "safari@3", text: SAFARI_GUIDE },
  extras: [
    {
      name: "tabs", access: "view",
      signature: "tabs(): Promise<{ tab: number; current: boolean; url: string; title: string }[]>",
      summary: "the bound window's tabs: index, current, URL, title",
      doc: "The tabs of the BOUND window only (bind another window to see its tabs). tab is the tab's index in the window (1 = leftmost); current marks the window's current tab.",
      async run(scope) {
        const result = checkBound(scope, await scope.applescript(appScript(scope.app.bundleId, [
          ...boundBrowserWindow(scope.window()),
          "set cur to index of ct",
          "set out to \"\"",
          "set i to 0",
          "repeat with t in (tabs of w)",
          "  set i to i + 1",
          `  set out to out & i & winterTAB & (i = cur) & winterTAB & ${TAB_ROW} & winterLF`,
          "end repeat",
          "return out",
        ], { handlers: ["text"] })));
        return rows(result, 4).map(([t, cur, url, title]) => ({ tab: Number(t), current: yes(cur), url: url ?? "", title: title ?? "" }));
      },
    },
    {
      name: "currentURL", access: "view",
      signature: "currentURL(): Promise<string>",
      summary: "the URL of the bound window's current tab",
      doc: "The URL of the current tab of the BOUND window (\"\" for an empty tab).",
      async run(scope) {
        const result = checkBound(scope, await scope.applescript(appScript(scope.app.bundleId, [
          ...boundBrowserWindow(scope.window()),
          "return \"URL:\" & my winterText(URL of ct)",
        ], { handlers: ["text"] })));
        return (result ?? "").replace(/^URL:/, "").trim();
      },
    },
    {
      name: "pageText", access: "view",
      signature: "pageText(o?: { tab?: number }): Promise<string>",
      summary: "the readable text of the bound window's current tab, or of { tab } in it",
      doc: "Safari's own text of the page (no links, no form values, no JavaScript run): the bound window's current tab, or its tab { tab } (an index from tabs()). At most 64,000 bytes.",
      async run(scope, args) {
        const o = optsArg(args[0], "pageText()", ["tab"]);
        const of = o.tab === undefined ? "ct" : `tab ${intArg(o.tab, "pageText({ tab })", 1, 10_000)} of w`;
        const result = checkBound(scope, await scope.applescript(appScript(scope.app.bundleId, [
          ...boundBrowserWindow(scope.window()),
          ...(o.tab === undefined ? [] : [`if ${o.tab} > (count of tabs of w) then return "NOTAB"`]),
          `return "TEXT:" & my winterText(text of ${of})`,
        ], { handlers: ["text"] }), { timeoutMs: 20_000 }));
        if ((result ?? "").trim() === "NOTAB") throw bad(`the bound window has no tab ${String(o.tab)} — tabs() lists them`);
        return (result ?? "").replace(/^TEXT:/, "");
      },
    },
    {
      name: "openURL", access: "full",
      signature: "openURL(url: string, o?: { newTab?: boolean }): Promise<{ tab: number }>",
      summary: "opens a URL in a new tab of the bound window, its current tab kept (newTab: false: in that tab)",
      doc: "http, https or file URLs, in the BOUND window: by default a new tab at its end, the window's current tab kept as it was; { newTab: false } loads the URL in the current tab instead (its page is replaced). Returns the tab's index. Your own browsing belongs in browsers.open; a Safari window of your own is openWindow(url).",
      async run(scope, args) {
        const url = urlArg(args[0], "openURL(url)");
        const o = optsArg(args[1], "openURL(url, o)", ["newTab"]);
        if (o.newTab !== undefined && typeof o.newTab !== "boolean") throw bad("openURL(url, { newTab }) takes true or false");
        const u = text(url);
        const result = checkBound(scope, await scope.applescript(appScript(scope.app.bundleId, [
          ...boundBrowserWindow(scope.window()),
          ...(o.newTab === false
            ? [`set URL of ct to ${u}`, "return \"TAB:\" & ((index of ct) as text)"]
            : [
              "set ci to index of ct",
              `make new tab at end of tabs of w with properties {URL:${u}}`,
              "set n to count of tabs of w",
              // Put the current tab back ONLY when Safari itself moved to the new tab — a switch the user made meanwhile
              // (to any other tab) is never undone.
              "if (index of current tab of w) = n and ci is not n then set current tab of w to tab ci of w",
              "return \"TAB:\" & (n as text)",
            ]),
        ]), { timeoutMs: 15_000 }));
        const tab = Number((result ?? "").replace(/^TAB:/, "").trim()) || 0;
        scope.say(o.newTab === false ? "loaded the URL in the bound window's current tab" : "opened the URL in a new tab at the end of the bound window (its current tab is unchanged)");
        return { tab };
      },
    },
    {
      name: "openWindow", access: "full",
      signature: "openWindow(url: string): Promise<{ window: number; frontmostAfter?: true }>",
      summary: "opens a URL in a NEW Safari window of your own (when the user wants Safari); bind it by the id it returns",
      doc: "For when the user wants the work done in Safari itself — your own browsing belongs in browsers.open. Makes a new Safari window showing the URL (http, https or file) and returns its id: bind it with apps.open(\"Safari\", { window: id }) and work there, never in the user's windows. Refused while Safari is the app the user is using (a new window would take their keyboard focus); frontmostAfter: true when Safari became it meanwhile — tell the user.",
      async run(scope, args) {
        const u = text(urlArg(args[0], "openWindow(url)"));
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "if frontmost then return \"FRONTMOST\"",
          "set before to id of every window",
          // Again right before the window is made (the user may have switched to Safari meanwhile), and once after.
          "if frontmost then return \"FRONTMOST\"",
          `make new document with properties {URL:${u}}`,
          "set frontAfter to frontmost",
          "set after to id of every window",
          "set fresh to {}",
          "repeat with i in after",
          "  if before does not contain (contents of i) then set end of fresh to (contents of i)",
          "end repeat",
          "if (count of fresh) is not 1 then return \"AMBIGUOUS\"",
          "return \"WINDOW:\" & ((item 1 of fresh) as text) & winterTAB & (frontAfter as text)",
        ]), { timeoutMs: 15_000 });
        const [head, frontAfter] = (result ?? "").trim().split("\t");
        const r = head ?? "";
        if (r === "FRONTMOST") throw new AutomationFailure("NeedsForeground", `${scope.app.name} is the app the user is using right now, and a new window would take their keyboard focus — ask the user, or work in the bound window. Nothing was done.`);
        const id = Number(r.replace(/^WINDOW:/, ""));
        if (!r.startsWith("WINDOW:") || !Number.isInteger(id) || id <= 0) {
          throw new AutomationFailure("NoWindow", `a new ${scope.app.name} window was made, but Winter could not tell which one it is (another window appeared at the same moment) — bind it by its title with apps.open("${scope.app.name}", { window: "<title>" })`);
        }
        if (frontAfter?.trim() === "true") {
          // The user switched to Safari while the window was being made: it may now hold their keyboard focus.
          scope.notice(`${scope.app.name} became the app the user is using while Winter made its new window (id ${id}) — that window may now have their keyboard focus. Tell the user, and don't type in ${scope.app.name} until they have answered.`);
          return { window: id, frontmostAfter: true as const };
        }
        scope.say(`opened a new ${scope.app.name} window of your own (id ${id}) — bind it with apps.open("${scope.app.name}", { window: ${id} })`);
        return { window: id };
      },
    },
  ],
};
