// Safari (`com.apple.Safari`, and Safari Technology Preview): its tabs, the front page's URL and text, and opening a
// URL — through its dictionary (`URL`, `name` and `text` of a tab; `make new tab`), never `do JavaScript` (the helper
// refuses it anywhere). Reading a page's text never touches the page; a new tab is made in the background.
import { AutomationFailure } from "../../errors";
import type { AppAdapter } from "../types";
import { appScript, intArg, optsArg, rows, text, urlArg, yes } from "./common";
import { SAFARI_GUIDE } from "../guides/safari";


/** `{ window, tab }` from tabs(), or the front document. */
function tabRef(o: Record<string, unknown>): string {
  if (o.window === undefined) {
    if (o.tab !== undefined) throw Object.assign(new TypeError("pageText({ tab }) needs its { window } (from tabs())"), { name: "TypeError" });
    return "front document";
  }
  const w = intArg(o.window, "pageText({ window })", 0, 2 ** 31 - 1);
  return o.tab === undefined ? `current tab of window id ${w}` : `tab ${intArg(o.tab, "pageText({ tab })", 1, 10_000)} of window id ${w}`;
}

export const safariAdapter: AppAdapter = {
  bundleIds: ["com.apple.Safari", "com.apple.SafariTechnologyPreview"],
  guide: { id: "safari@1", text: SAFARI_GUIDE },
  extras: [
    {
      name: "tabs", access: "view",
      signature: "tabs(): Promise<{ window: number; tab: number; current: boolean; url: string; title: string }[]>",
      summary: "every tab of every Safari window: window id, index, current, URL, title",
      doc: "Every browser window's tabs, front window first. window is the window's id (pass it to pageText), tab is the tab's index in its window (1 = leftmost), current is the window's current tab.",
      async run(scope) {
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "set out to \"\"",
          "repeat with w in windows",
          "  try",
          "    set wid to id of w",
          "    set cur to index of current tab of w",
          "    set i to 0",
          "    repeat with t in (tabs of w)",
          "      set i to i + 1",
          "      set out to out & wid & winterTAB & i & winterTAB & (i = cur) & winterTAB & my winterText(URL of t) & winterTAB & my winterText(name of t) & winterLF",
          "    end repeat",
          "  end try",
          "end repeat",
          "return out",
        ], { handlers: ["text"] }));
        return rows(result, 5).map(([w, t, cur, url, title]) => ({ window: Number(w), tab: Number(t), current: yes(cur), url: url ?? "", title: title ?? "" }));
      },
    },
    {
      name: "currentURL", access: "view",
      signature: "currentURL(): Promise<string>",
      summary: "the URL of Safari's front page",
      doc: "The URL of Safari's front document (the current tab of its frontmost browser window); \"\" when Safari shows no page.",
      async run(scope) {
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "if (count of documents) = 0 then return \"\"",
          "return my winterText(URL of front document)",
        ], { handlers: ["text"] }));
        return (result ?? "").trim();
      },
    },
    {
      name: "pageText", access: "view",
      signature: "pageText(o?: { window?: number; tab?: number }): Promise<string>",
      summary: "the readable text of the front page, or of a tab from tabs()",
      doc: "Safari's own text of the page (no links, no form values, no JavaScript run): the front document, the current tab of { window }, or { window, tab } from tabs(). At most 64,000 bytes.",
      async run(scope, args) {
        const o = optsArg(args[0], "pageText()", ["window", "tab"]);
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          ...(o.window === undefined ? ["if (count of documents) = 0 then return \"\""] : []),
          `return my winterText(text of ${tabRef(o)})`,
        ], { handlers: ["text"] }), { timeoutMs: 20_000 });
        return result ?? "";
      },
    },
    {
      name: "openURL", access: "full",
      signature: "openURL(url: string, o?: { newTab?: boolean }): Promise<{ window: number; tab: number }>",
      summary: "opens a URL in a new background tab of the front window (newTab: false: in its current tab)",
      doc: "http, https or file URLs. By default a new tab at the end of the front window, whose current tab is kept as it was; { newTab: false } loads the URL in the current tab instead (its page is replaced). With no browser window it fails (NoWindow). Returns where the page is.",
      async run(scope, args) {
        const url = urlArg(args[0], "openURL(url)");
        const o = optsArg(args[1], "openURL(url, o)", ["newTab"]);
        if (o.newTab !== undefined && typeof o.newTab !== "boolean") throw Object.assign(new TypeError("openURL(url, { newTab }) takes true or false"), { name: "TypeError" });
        const u = text(url);
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "if (count of documents) = 0 then return \"NOWINDOW\"",
          "set w to front window",
          ...(o.newTab === false
            ? [`set URL of current tab of w to ${u}`, "return ((id of w) as text) & winterTAB & ((index of current tab of w) as text)"]
            : [
              "set ci to index of current tab of w",
              `make new tab at end of tabs of w with properties {URL:${u}}`,
              "set n to count of tabs of w",
              // The user's current tab stays current, whether or not Safari switched to the new one.
              "set current tab of w to tab ci of w",
              "return ((id of w) as text) & winterTAB & (n as text)",
            ]),
        ]), { timeoutMs: 15_000 });
        if ((result ?? "").trim() === "NOWINDOW") throw new AutomationFailure("NoWindow", "Safari has no browser window to open a tab in — ask the user to open one (Winter never opens a browser window in front of them)");
        const [row] = rows(result, 2);
        const where = { window: Number(row?.[0] ?? 0), tab: Number(row?.[1] ?? 0) };
        scope.say(o.newTab === false ? "loaded the URL in the front window's current tab" : "opened the URL in a new tab at the end of the front window (its current tab is unchanged)");
        return where;
      },
    },
  ],
};
